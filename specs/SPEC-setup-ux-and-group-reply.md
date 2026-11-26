# SPEC: Setup panel redesign + group reply policy

**Date:** 2026-11-25
**Status:** implemented in 0.8.0

## Goal
1. A calm, low-effort setup panel: one identity (the Telegram bot's `@username`), sections, rare options behind a disclosure, an explicit "who can talk" choice.
2. In groups with **All messages**, a per-bridge reply policy: **only when addressed** (mention, reply to the bot, command for it; default for new bridges) or **when it can help**.

## Contract (src/protocol.ts)
- `GroupReply = 'mentioned' | 'helpful'`; `BridgeConfig.groupReply`; `SaveConfigInput.groupReply?` (absent keeps).
- `SaveConfigInput.name?` is optional; absent keeps the saved name. The panel stops sending it.
- Internal keys stay the stable bridge `id`. `@username` is a display label only (it can change, and is unknown until the token is checked).

## Group reply behavior (worker)
- Applies only to messages that `groupMessageText` returns with `addressed: false` (group, groupMode `all`, restricted allowlist). Addressed messages (mention, reply to the bot, command for it) are unchanged.
- Each unaddressed message is still sent to the Orca bot (it "reads everything"); its reply rule replaces the usual "your final message will be sent back to Telegram" line, so the two never contradict each other:
  - `mentioned`: `This group message was not addressed to you. Read it for context only and do not reply: answer exactly NO_REPLY. Nothing you write is sent to Telegram.` (no attachment syntax line: nothing goes back)
  - `helpful`: `This group message was not addressed to you. Reply only if you can clearly help with it; otherwise answer exactly NO_REPLY. A reply is sent back to the group (use standard Markdown tables; avoid wide ASCII box tables).`
- `mentioned` is enforced by the bridge: whatever the bot answers to an unaddressed message is not sent to Telegram (logged at info with its length only).
- Unaddressed messages are quiet: no typing action, and no user-facing error or notice lines in the group (processing failure, unsupported image, voice not enabled / transcription failure); those are logged only.
- Default `groupReply`: `mentioned` for new bridges. A bridge stored before 0.8.0 with groupMode `all` (and no `groupReply`) starts at `helpful`, because it answered every group message before; others start at `mentioned`.

## Panel (src/panel.tsx)
- Card: title `@username` (fallback: "New Telegram bot" before the token is checked), description `→ <Orca bot>`. One switch row with the status badge. Summary lines in plain words. Actions: **Edit** only; **Remove** moves to the editor footer with the existing confirm step.
- Editor sections (Heading + spacing): **Connection** (token, Orca bot) · **Who can talk** (radio: "Only these people and groups" with the IDs field / "Anyone on Telegram" with a warning Callout) · **Groups** (0.8.2: one radio "In groups" whose options each say what the bot reads and when it answers — Off / Answers when called / Follows the conversation, answers when called / Follows the conversation, joins in when useful — mapped to allowGroups + groupMode + groupReply; a helper for the per-message bot-turn cost; privacy-mode Callout with numbered steps) · **Features** (voice switch + provider + key; sync switch) · **Advanced** Collapsible, closed (reply language, reply timeout, HTTP proxy, transcription model).
- Name field removed. Chats tab and log filter label bridges by `@username` (fallback to the stored name).
- Footer: Save (primary), Cancel (ghost); Test connection (outline) and Remove (ghost, danger) after them.
- Sentence case for every label and button.

## Acceptance Criteria
1. [x] A bridge saved without `name` keeps its name; `groupReply` round-trips and defaults to `mentioned`.
2. [x] Unaddressed group message, `mentioned`: handoff has the silent line; nothing is sent to the group even if the bot answers text; no typing action.
3. [x] Unaddressed group message, `helpful`: handoff has the helpful line; a text answer is sent; `NO_REPLY` sends nothing.
4. [x] Addressed group messages and private chats behave as before.
5. [x] Panel: no Name field; card title is `@username`; "Anyone on Telegram" saves an empty allowlist; "Only these people" with no ID was refused with a clear message (replaced in #3: it now saves as `restricted` with an empty list, and nobody talks until allowed from the card); reply policy is shown only with All messages; Advanced is closed by default.
6. [x] `orca plugin test` (183) and `orca plugin check` pass; tsc shows no new error (12 older type-only errors remain).

## Out of Scope
- Buffering unaddressed messages as context for a later mention.
- Changing how addressed messages are detected.
