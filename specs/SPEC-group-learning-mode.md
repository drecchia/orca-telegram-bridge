# SPEC: Group learning mode (never answers)

**Date:** 2026-11-26
**Status:** implemented
**Issue:** #4

## Goal
A fifth **Groups** option: the bot joins a group, sends every message to the Orca bot so it can learn patterns (what it learns is up to the Orca bot's `SOUL.md`), and never posts anything in the group, even when called.

## Behavior
Learning = `allowGroups` + `groupMode: 'all'` + `groupReply: 'learn'`.
- When any group message arrives (text, image, file, voice), then it is saved for the next batch (see Batching), and nothing goes back to the group: no reply, no typing, no working line, no error or notice line.
- When the message is an @mention or a reply to the bot, then it is handled like any other line (learning, not answered). The mention is still removed from the text.
- When the message is a command (`/x` or `/x@thisbot`), then it is not run and not sent to the Orca bot (debug log only). Commands always answer, so learning mode cannot run them.
- When a button on an older bot message in the group is pressed, then nothing happens (debug log; the tap is not answered).
- When the Orca bot answers anything but `NO_REPLY`, then the bridge withholds it (info log with length only), like `mentioned`.
- When the sender is not on the allowlist, or the role may not chat, then the message is ignored quietly (no access-denied line).
- When any message (commands too) comes from a group not on the allowlist, then the panel shows the group with **Allow group \<ID\>** and a warn log names the group ID (once a minute per group; the bot joining does not count; issue #11). A listed person's line there still reaches the Orca bot. When the bot leaves or is removed from the group, then the banner goes; while groups are off, it is hidden.
- When the bridge is open to everyone, then the bot reads nothing in groups (same rule as the other "follows" options) and still never answers there.
- When Orca-side sync is on, then group chats of this bridge are not synced (private chats still are).
- Private chats: unchanged.
- When privacy mode is on (`/setprivacy`), then Telegram sends the bot only messages meant for it (commands, replies to it), so ordinary group lines never reach learning mode. The panel's privacy callout and the "Added to group" log say so (issue #8).

The learning line replaces the "will be sent back" line in the handoff (no attachment or language line); since issue #14 it goes with each batch (see Batching).

## API / Interface
- `src/protocol.ts`: `GroupReply = 'mentioned' | 'helpful' | 'learn'`.
- Stored and saved `groupReply: 'learn'` round-trips; unknown values keep today's fallback.

## Implementation Outline
- `src/orca-bridge.ts` — `UNADDRESSED_GROUP_LINES.learn`; the attachment/language lines skipped for `learn` as for `mentioned`.
- `src/worker.ts` — normalize/save accept `learn`; `groupMessageText`: in learning, commands → null, mention/reply → `addressed: false`; withhold rule `groupReply !== 'helpful'`; withheld log names the mode; `acceptCallbackQuery` ignores group taps while learning; sync filter skips group bindings while learning.
- `src/panel.tsx` — option `all-learn` "Learns from the conversation, never answers"; card summary; cost helper and ID-list note also for it.
- `README.md` — row in the Groups table + one line on commands/buttons.
- Tests: `worker.test.ts` (mention + plain line + command + button + sync), `panel.test.tsx` (option maps to `learn`, summary).

## Acceptance Criteria
1. [x] `groupReply: 'learn'` round-trips through save and storage.
2. [x] Learning: a plain line, a mention and a reply to the bot reach the Orca bot with the learning line; nothing is sent to the group; no typing action.
3. [x] Learning: a command for the bot is not run, not dispatched, and sends nothing.
4. [x] Learning: a group button tap does nothing and sends nothing.
5. [x] Learning + sync on: a group binding is not synced; a private binding is.
6. [x] Other options behave as before (existing tests pass).
7. [x] Panel: the option saves `allowGroups: true, groupMode: 'all', groupReply: 'learn'`; card says "Groups: learns from the conversation, never answers".
8. [x] `orca plugin test` (267) and `orca plugin check` pass; tsc shows no error.

## Batching (issue #14, "Modo 1")
Learning mode no longer sends one Orca bot turn per group message.
- When a group line arrives in learning mode (after the allowlist and role checks above), then the bridge appends it to the group's file `<learnDir>/.orca-telegram-bridge/learning/<bridge id>/<group id>.txt` (default `learnDir`: the home folder) as `[ISO time] sender: text`; further lines of a message are indented by two spaces. Images, files and voice messages are saved as `[image]`, `[file: name]` or `[voice message]` plus their caption; nothing is downloaded or transcribed. Nothing is dispatched.
- Durability: the append is flushed to disk (`fsync`) before the Telegram update offset is saved; for a learning group line the early offset save is skipped. When the write fails, the in-memory offset steps back to that update and the error goes to the poll loop, which backs off and gets the update again from Telegram.
- Setting `learnBatchHours` per bridge (integer 1–168, default 6; out-of-range values are clamped; absent on save keeps the saved value). Panel: **Send what it learned every (hours)**, shown only under the learning option.
- While polling, a loop checks every minute. When `learnBatchHours` have passed since `learnBatchAt` (stored per bridge; set at the first start), then it stores the new `learnBatchAt` and, for each group with a file, moves `<group id>.txt` to `<group id>.<n>.batch.txt` (under a lock shared with the append, so lines that arrive later start a new `<group id>.txt`) and sends all of that group's batch files in ONE dispatch with the learning line, in the group's Orca chat.
- When a group's file is missing or empty, then nothing is sent.
- When the dispatch succeeds, then the batch files are deleted and the group's Orca chat binding is reset (`resetBinding`), so the next batch starts a new Orca chat. The Orca bot's answer is never sent to Telegram.
- When the dispatch fails (or no Orca bot is found), then the batch files stay and go with the next batch, before any newer lines (warn log).
- The role prompt of each sender is not added to a batch (one batch has many senders).
- **Send now** (issue #24): in the editor, under **Send what it learned every (hours)**, shown only while the saved setup is learning mode. It asks the worker (`bridge.sendLearnedNow`) to send the batch at once, by the same path as the timer (it also stores the new `learnBatchAt`, so the count restarts). The worker answers before the batch ends (a batch can outlast a panel request); its end goes to the logs. When learning mode is off (saved setup) or no group has saved lines, then nothing is sent and the panel says so. Batches run one at a time, so a press during the timer's batch never sends the same lines twice.

Learning line in a batch's handoff (first line `Telegram group messages (chat <id>) [tg:…]`):
`You are in learning mode in this Telegram group: below is a batch of the messages people sent there since the last batch, one per line as "[time] sender: text" (the further lines of a message are indented). Read them and learn from them as your instructions (SOUL.md) say. Never reply, even when a message mentions or asks you: answer exactly NO_REPLY. Nothing you write is sent to Telegram.`

## Out of Scope
- Storing learned patterns anywhere: the Orca bot and its `SOUL.md` decide that.
- Keeping the last messages as context across batches ("Modo 2" in issue #14).
- Sending the content of images, files and voice messages in a batch.
- A per-group choice (the option stays per bridge).
