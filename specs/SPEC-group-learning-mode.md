# SPEC: Group learning mode (never answers)

**Date:** 2026-11-26
**Status:** implemented
**Issue:** #4

## Goal
A fifth **Groups** option: the bot joins a group, sends every message to the Orca bot so it can learn patterns (what it learns is up to the Orca bot's `SOUL.md`), and never posts anything in the group, even when called.

## Behavior
Learning = `allowGroups` + `groupMode: 'all'` + `groupReply: 'learn'`.
- When any group message arrives (text, image, file, voice), then it goes to the Orca bot with the learning line, and nothing goes back to the group: no reply, no typing, no working line, no error or notice line.
- When the message is an @mention or a reply to the bot, then it is handled like any other line (learning, not answered). The mention is still removed from the text.
- When the message is a command (`/x` or `/x@thisbot`), then it is not run and not sent to the Orca bot (debug log only). Commands always answer, so learning mode cannot run them.
- When a button on an older bot message in the group is pressed, then nothing happens (debug log; the tap is not answered).
- When the Orca bot answers anything but `NO_REPLY`, then the bridge withholds it (info log with length only), like `mentioned`.
- When the sender is not on the allowlist, or the role may not chat, then the message is ignored quietly (no access-denied line).
- When the bridge is open to everyone, then the bot reads nothing in groups (same rule as the other "follows" options) and still never answers there.
- When Orca-side sync is on, then group chats of this bridge are not synced (private chats still are).
- Private chats: unchanged.

Learning line in the handoff (replaces the "will be sent back" line; no attachment or language line):
`You are in learning mode in this Telegram group: read this message and learn from it as your instructions (SOUL.md) say. Never reply, even when the message mentions or asks you: answer exactly NO_REPLY. Nothing you write is sent to Telegram.`

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

## Out of Scope
- Storing learned patterns anywhere: the Orca bot and its `SOUL.md` decide that.
- Batching messages to cut the one-turn-per-message cost.
- A per-group choice (the option stays per bridge).
