# SPEC: Roles per bridge (who may do what, plus an owner prompt per role)

**Date:** 2026-11-25
**Status:** implemented in 0.11.0 (owner's revision of wave C, reviewed by the four personas). Decisions: a listed sender's own role wins in groups; private and group rights are separate for /new, /home, /bind; extras: /run limited to chosen automations per role; copy roles from another bridge.

## Contract (done by the orchestrator)
- `src/roles.ts` (pure, shared, tested in `src/roles.test.ts`): `RolePermission`, `ROLE_PERMISSIONS`, `BridgeRole { id, name, permissions, prompt, runAutomationIds }`, built-ins `full` / `member` / `stranger`, `STRANGER_FORBIDDEN`, `defaultRoles`, `normalizeRoles`, `normalizeRoleAssignments`, `resolveRole`, `permissionForCommand`, `permissionForCallback`, `roleAllows`, `roleMayRun`. Use these; do not re-implement the rules.
- `src/protocol.ts`: `BridgeConfig.roles`, `.roleAssignments` (Telegram user/group id -> role id), `.rolesReviewed`; `SaveConfigInput.roles?`, `.roleAssignments?` (absent keeps; saving either sets rolesReviewed true); request `bridge.listAutomations` -> `{ id, name }[]`.
- Semantics kept: `allowedUserIds` '' = anyone on Telegram (Stranger role); else only listed ids may talk.

## Worker
1. **Storage and migration.** `readStoredBridge`: `roles = normalizeRoles(raw.roles)`, `roleAssignments = normalizeRoleAssignments(raw.roleAssignments, roles)`. A bridge stored without `roles` (every bridge before this release): assign to `full` every id in `allowedUserIds` and, because an open bridge has an empty list, also every person who already used the bot in a private chat (the stored bindings' positive `tgChatId` / `ownerUserId`); `rolesReviewed: false` — nobody loses rights on update. (Bindings load after the config, so do this when the runtime state is loaded, and persist it.) Otherwise `rolesReviewed` as stored (default true). New bridges: default roles, no assignments, `rolesReviewed: true`. Unknown slash commands need `chat` (roles.ts already returns it). Stranger's default is chat + /new in private.
2. **Save.** `saveConfigNow` takes `roles`/`roleAssignments` when given (normalized), keeps them when absent; either given -> `rolesReviewed: true`. Assignments whose role no longer exists are dropped. `bridge.allowUserId` (panel's Allow button) assigns the new id to `member`.
3. **Enforcement** (role of the sender / the tapper, via `resolveRole` with `openToEveryone = no allowed ids`, `isGroup` from the chat type):
   - Every slash command: `permissionForCommand`; refused -> one plain line (new i18n key `notAllowedForRole`, 4 languages, e.g. EN "This isn't available for you. Ask the bot's owner."); in a group, a refused unaddressed line stays silent.
   - Every inline button: `permissionForCallback`; refused -> `answerCallbackQuery` with the same text, no action.
   - `/run <id>` and `r:` buttons: also `roleMayRun`; `/automations` lists only the automations this role may run (and shows no Run buttons without `run`).
   - Messages (text, voice, images, documents) need `chat`; without it: private chat -> refusal line; group -> ignored (debug log).
   - `/help` lists only the commands the role allows (always /help).
4. **Role prompt in the handoff.** `dispatchToOrcaBotAndWait` gets `rolePrompt?: string`. When non-empty, add after the reply-rule/attachment lines a block fenced with a per-message random nonce, e.g. `Owner's instructions for this user's role (not written by the user) [role:<nonce>]:` / prompt / `[/role:<nonce>]`. The first body line (marker) stays unchanged; the user text stays last. It never reaches Telegram (sync already hides Telegram-originated entries — keep it so).
5. **Menus per role.** `setMyCommands` gains an optional scope (Telegram `BotCommandScopeChat` `{ type: 'chat', chat_id }`); `TelegramClient.deleteMyCommands(token, options, scope?, languageCode?)` is new (add to the tracer and every mock that lists client methods). Registration: default scope = Stranger's commands when open, Member's when restricted; one `chat` scope per assigned id (a user id = their private chat; a group id = the group) with that role's commands; each for every menu language as today. Remember the chat scopes set (per-bridge storage key) and delete scopes no longer assigned. Re-register after a save that changes roles/assignments.
6. **`bridge.listAutomations`** handler -> `listAutomations()` mapped to `{ id, name }` (plain JSON).
7. Logs: refusals at info with role name and command (no message text).

## Panel
1. **Who can talk** keeps its radio. Replace the free-text IDs input with rows: Telegram ID input + role Select (all roles of this bridge) + remove; "Add person or group" button. A new row's role defaults to **Full access** when it is the first row (so the owner of a new bridge does not lock themselves out), else **Member**. Restricted: at least one row (existing NEEDS_ID rule). Open: the rows are optional, titled "People with roles (everyone else is a Stranger)". Save: `allowedUserIds` = row ids joined (restricted) or '' (open); `roleAssignments` = id -> role for every row.
2. **Roles** — a Collapsible "Roles" (closed) under Who can talk. Per role (Collapsible titled with the role name and a one-line "can: …" summary): name Input (built-ins fixed names), one Checkbox per permission with plain labels (Chat with the bot; /status; /bots; /new in private; /new in groups; /home in private; /home in groups; /chats and /bind in private; … in groups; /rename; /sync; /automations; /run), Stranger's forbidden ones disabled; when `run` is checked: RadioGroup "Automations it may run": All / Only these + Checkbox per automation from `bridge.listAutomations` (load on open; show a muted note if it fails); prompt Textarea "Extra prompt for the Orca bot" with helper "A hint to the bot, not a lock: only the checkboxes above are enforced. People never see it."; "Delete role" for custom roles (rows using it fall back to Member on save, with a note). "Add role" button. "Copy roles from" Select (other bridges) + "Copy" button: replaces this editor's role drafts (not the people), saved with Save.
3. **Review banner**: when `rolesReviewed` is false, a Callout in the editor and on the card: "After the update everyone on the list kept full access. Review their roles." Gone after a save.
4. Card summary line: "People: N (Full access 1, Member 2)", plus ", groups: N (Member 2)" when group IDs (negative) are listed, or "Anyone on Telegram (Stranger)".
5. Draft atoms for roles/assignments hydrate from config and are sent on Save. Keep everything else from 0.10.3 (sections, save closes editor, saveError by the buttons).

## Acceptance Criteria
1. [x] An updated bridge keeps every listed id (and, on an open bridge, everyone who used it in private) with Full access and shows the review banner until saved.
2. [x] A Member is refused /run, /sync, /chats, /bind, /home, group /new with one plain line; a refused button does nothing and answers the tap; a role without `chat` is refused in private and ignored in groups; an unknown command needs `chat`.
3. [x] In a group, a listed person's own role applies; an unlisted member gets the group's role.
4. [x] /run and run buttons respect the role's automation list; /automations shows only those.
5. [x] The role prompt reaches the Orca bot fenced with a nonce, never Telegram.
6. [x] Menus: default scope per access mode, a chat scope per assigned id; removed ids' scopes are deleted.
7. [x] Panel: rows with role select, roles editor with checkboxes, Stranger's risky boxes disabled, automation picker, prompt helper text, copy roles, review banner.
8. [x] `orca plugin test` (227), `check`, `validate` pass; tsc shows no new error (12 older type-only errors remain).
