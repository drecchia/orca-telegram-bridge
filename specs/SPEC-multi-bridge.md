# SPEC: Multiple Telegram bridges (one Telegram bot ↔ one Orca bot, many pairs)

**Date:** 2026-11-25
**Status:** implemented in 0.5.0 (D1 pinned, D2 everything per bridge except debug logging, group options)

## Goal
Today the plugin runs exactly one Telegram bot token, so only one Telegram bot can front the Orca
bots. Users want several pairs, e.g. `@ci_bot` ↔ Orca bot `CIWatcher` and `@dev_bot` ↔ Orca bot
`DevHelper`, each with its own access list, language and on/off state. The ideal (a Telegram
connector inside Orca's Bot settings → Connectors) is not possible from a plugin: the plugin API
cannot contribute bot connectors (`contributes.connections` is reserved, no schema), and the
built-in connectors are slack, linear, github, google and webhook. That request lives upstream in
stablyai/orca#45959. This spec delivers the closest equivalent inside the plugin.

## Behavior
- A **bridge** = one Telegram bot token + one Orca bot + its own settings. The panel lists bridges;
  the user can add, edit, rename, remove, and turn each one on or off.
- Each active bridge long-polls its own token, with its own update offset, chat bindings, sync
  cursors, blocked-user banner, status and logs (logs tagged with the bridge name).
- A message to Telegram bot A is routed only to A's Orca bot (see decision D1 for `/use`).
- The same token cannot be used by two bridges (Telegram allows one poller per token): saving a
  duplicate token is refused with a clear error.
- Removing a bridge stops its poller, deletes its token from secrets and its stored state.
- First start after the update migrates the current single configuration into "Bridge 1"
  (token, default bot, allowlist, proxy, timeout, language, enabled, sync, bindings, offset) without
  re-entering anything; a paused bot stays paused; log entries stay. The migration copies the
  new keys, reads them back, then deletes the legacy keys, and resumes safely if Orca stops midway.
- Status bar (one item; the manifest allows only static items): `TG: 2/3` (connected / active),
  tone by worst state; tooltip lists each bridge; click opens the panel (as today).
- `/start`, `/help` and the command menu are per Telegram bot (each token registers its menu).

## API / Interface
- `BridgeConfig` gains `id` and `name`; `BridgeState` becomes `{ bridges: BridgeView[], logs, logTotal, global: GlobalConfig }`
  where `BridgeView` = today's per-bridge fields (status, polling, botUsername, lastError,
  lastBlockedUserId, unlistedGroup, config, bindings) plus `id`, `name`.
- Panel handlers take `bridgeId` where they act on one bridge: `bridge.saveConfig`, `testConnection`,
  `setEnabled`, `allowUserId`, `resetBinding`; new `bridge.add` → `{ bridgeId }`, `bridge.remove({ bridgeId })`.
- Storage: `bridges` (array of non-secret configs, all per-bridge settings incl. proxy and timeout);
  per bridge `tg.<id>.offset|bindings|syncCursors|lastBlocked|unlistedGroup`, keyed by the stable bridge id.
  Secrets: `botToken.<id>`. Only `debugLogging` stays a plugin setting; the old settings stay
  declared for one release so the migration can read them.
- Plugin key for the status-bar "open panel" command: resolved once via `orca plugin list --json`
  (match this plugin's folder/source), falling back to `<publisher>.<id>`.

## Implementation Outline
- `src/worker.ts` — split `TelegramBridgeController` into `BridgeRuntime` (today's per-bridge logic,
  parameterized by a `BridgeContext { id, name, secretKey, storagePrefix, config }`) and
  `BridgeManager` (owns the list, global config, logs, status bar, panel handlers, migration,
  duplicate-token guard). Most of the 2800 lines move unchanged; the 29 storage/settings/secrets
  calls go through the context.
- `src/protocol.ts` — new state/handler shapes above.
- `src/panel.tsx` — Setup tab becomes a list of bridge cards (name, Telegram @username, Orca bot,
  status, Bot active switch, Edit/Remove) plus "Add bridge"; the edit form is today's form scoped to
  one bridge; Chats tab groups bindings by bridge; Logs tab filter by bridge.
- `orca-plugin.json` — per-bridge settings leave the flat settings list (they move to storage);
  global settings stay.
- `README.md` — "Bridges" section; Setup steps per bridge.
- Tests: migration from 0.4.0 state; two bridges route to their own Orca bots; duplicate token
  refused; remove stops polling and deletes the secret; one bridge's 401 does not stop the other;
  panel add/edit/remove; status bar aggregate.

## Acceptance Criteria
1. [x] Two bridges with two tokens run at the same time; each Telegram bot reaches only its Orca bot. (worker tests, simulated Telegram)
2. [x] An existing 0.4.0 setup appears as "Bridge 1" after the update and keeps working without input. (migration tests, incl. resume after a crash midway)
3. [x] A duplicate token is refused; removing a bridge stops it and deletes its token.
4. [x] A failure in one bridge (401, proxy, CLI) leaves the others running. (401 tested; proxy/CLI share the same isolation)
5. [x] Status bar shows the aggregate and opens the panel.
6. [x] `orca plugin test` (130) and `orca plugin check` pass; tsc shows no new error (12 older type-only errors remain in test files and the proxy agent).

## Decisions (approved)
- D1: pinned. Each Telegram bot talks only to its Orca bot; `/use` and the bot buttons explain that instead of switching.
- D2: everything per bridge (name, token, Orca bot, allowlist, proxy, reply timeout, reply language, active, Orca→Telegram sync). Global: debug logging only.

## Addendum: group options per bridge (approved by request, same release)
- `BridgeConfig.allowGroups: boolean`; when on, a sub-option `groupMode: 'addressed' | 'all'`
  (the panel shows it only while `allowGroups` is on).
  - `addressed` (default): commands for this bot, replies to the bot, `@bot` mentions.
  - `all`: every message an allowed sender writes in the group reaches the Orca bot. It takes
    effect only with a restricted allowlist; while the bridge is open to everyone it behaves as
    `addressed` (a busy group would otherwise turn every stranger's line into an Orca run), and
    the panel says so.
- Implementation: `getUpdates` `allowed_updates` adds `my_chat_member`; the `getMe` type gains
  `can_join_groups` and `can_read_all_group_messages`.
- `allowGroups` off: group messages are ignored, and when the bot finds itself in a group
  (a `my_chat_member` update or any group message) it leaves with `leaveChat` and logs it.
- Telegram limits shown in the panel, read from `getMe` (`can_join_groups`,
  `can_read_all_group_messages`); the plugin cannot change them, only `@BotFather` can:
  groups allowed but `/setjoingroups` disabled; `all` or mentions wanted but privacy mode on
  (`/setprivacy` → Disable, then re-add the bot).
- `allowGroups` on: when the bot is added to a group (or its status there changes), the bridge
  reads `getMe` again and logs at info level `Added to group <id> (<title>): the bot is a
  member.`, with a privacy-mode note while privacy mode keeps messages away and, on a restricted
  bridge, the hint to add the group ID to the list. `getMe` is also read on every poll run, so a
  `@BotFather` change shows after a reconnect (issue #8).
- Defaults: new bridges `allowGroups: false`; the migrated Bridge 1 keeps today's behavior
  (`allowGroups: true`, `groupMode: 'addressed'`).

## Out of Scope
- A real Orca Bot-settings connector (needs Orca core: stablyai/orca#45959).
- More than one status bar item per bridge (manifest items are static).
- Webhook mode for Telegram.
