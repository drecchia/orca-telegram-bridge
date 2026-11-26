// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
import type { ReplyLanguageSetting } from './i18n'
import type { BridgeRole } from './roles'

export {}

export type BridgeConnectionStatus =
  | 'needs_token'
  | 'stopped'
  | 'connecting'
  | 'connected'
  | 'error'

export type ChatBinding = {
  tgChatId: string
  // Telegram user who last used this binding; outbound sync stops once they leave the allowlist.
  ownerUserId?: string
  botId?: string
  botName: string
  orcaChatId: string | null
  title?: string
  updatedAt: number
}

export type LogScope = 'bridge' | 'telegram' | 'orca-cli' | 'dispatch' | 'sync' | 'config'

export type BridgeLogEntry = {
  id: string
  at: number
  level: 'debug' | 'info' | 'warn' | 'error'
  // Optional: entries stored by 0.2.0 have none.
  scope?: LogScope
  // The bridge the entry belongs to; absent for plugin-wide entries and entries from before 0.5.0.
  bridgeId?: string
  message: string
  // Multi-line, redacted, at most 3000 chars.
  details?: string
}

export type BotSummary = {
  id: string
  name: string
  specialty: string
  agent: string
}

// In a group: only messages for the bot (commands for it, replies to it, @mentions), or every message.
export type GroupMode = 'addressed' | 'all'

// With groupMode 'all', what the bot does with a message not addressed to it: stay silent (the
// message only gives it context), or answer when it can clearly help (else NO_REPLY). 'learn' reads
// every message to learn from it and never answers in the group, not even when called.
export type GroupReply = 'mentioned' | 'helpful' | 'learn'

// Where voice messages are transcribed; both speak OpenAI's /audio/transcriptions API.
export type VoiceProvider = 'openrouter' | 'openai'

// One bridge: one Telegram bot token and the one Orca bot it talks to. Everything here is per bridge.
export type BridgeConfig = {
  id: string
  name: string
  hasToken: boolean
  enabled: boolean
  // The Orca bot this Telegram bot is pinned to ('' = the first Orca bot found).
  orcaBot: string
  // Who may talk: false = anyone on Telegram (they get the Stranger role); true = only the IDs in
  // allowedUserIds. A restricted list may be empty: nobody talks until the owner allows someone.
  restricted: boolean
  allowedUserIds: string
  // What each kind of person may do, and the owner's extra prompt for them. See src/roles.ts.
  roles: BridgeRole[]
  // Telegram user or group ID -> role id. A listed sender's own role wins, also in groups; group
  // members not listed get the group's role; others get Member (restricted) or Stranger (open).
  roleAssignments: Record<string, string>
  // False after an update gave everyone already allowed Full access, until the owner saves roles.
  rolesReviewed: boolean
  // Off by default: when on, a group gets one line when someone changes its shared state
  // ("@joao started a new chat").
  groupAuditNotice: boolean
  proxyUrl: string
  replyTimeoutSec: number
  syncOrcaOutbound: boolean
  replyLanguage: ReplyLanguageSetting
  // Off: group messages are ignored and the bot leaves any group it is added to.
  allowGroups: boolean
  // 'all' takes effect only while restricted; while open it acts as 'addressed'.
  groupMode: GroupMode
  groupReply: GroupReply
  // Voice messages and audio files are transcribed, then sent to the Orca bot as text.
  voiceEnabled: boolean
  voiceProvider: VoiceProvider
  // '' = the provider's default model.
  voiceModel: string
  hasVoiceKey: boolean
}

export type BridgeView = {
  id: string
  name: string
  status: BridgeConnectionStatus
  polling: boolean
  botUsername: string | null
  botDisplayName: string | null
  lastError: string | null
  lastBlockedUserId: string | null
  // The latest group not on a restricted allowlist that the bot heard from or joined; null once listed.
  unlistedGroup: { id: string; title: string } | null
  lastPollAt: number | null
  config: BridgeConfig
  bindings: ChatBinding[]
  // What @BotFather allows for this bot, from getMe; null until the bot has connected once.
  telegramCaps: { canJoinGroups: boolean; canReadAllGroupMessages: boolean } | null
  // Names of the listed Telegram IDs, for the editor's "People and groups" rows: "@username", else
  // "First Last" for a person, a group's title. Only IDs on the bridge's list; absent when unknown.
  knownNames: Record<string, string>
}

export type GlobalConfig = {
  debugLogging: boolean
}

export type BridgeState = {
  // In creation order.
  bridges: BridgeView[]
  // The Orca bots on this computer; shared by every bridge.
  bots: BotSummary[]
  global: GlobalConfig
  // The newest 40 stored entries of every bridge, newest first; logTotal counts every stored entry.
  logs: BridgeLogEntry[]
  logTotal: number
}

export type SaveConfigInput = {
  bridgeId: string
  // Absent keeps the saved name; the panel no longer edits it and shows the bot's @username.
  name?: string
  botToken?: string
  clearToken?: boolean
  // Absent keeps the current state; the panel switches a bridge with `bridge.setEnabled`.
  enabled?: boolean
  orcaBot: string
  restricted: boolean
  allowedUserIds: string
  // Absent keeps the saved roles and assignments; saving either marks the roles as reviewed.
  roles?: BridgeRole[]
  roleAssignments?: Record<string, string>
  // Absent keeps the current value.
  groupAuditNotice?: boolean
  proxyUrl: string
  replyTimeoutSec: number
  syncOrcaOutbound: boolean
  replyLanguage?: ReplyLanguageSetting
  // Absent keeps the current value.
  allowGroups?: boolean
  groupMode?: GroupMode
  groupReply?: GroupReply
  voiceEnabled?: boolean
  voiceProvider?: VoiceProvider
  voiceModel?: string
  // Empty or absent keeps the saved key.
  voiceApiKey?: string
  clearVoiceKey?: boolean
}

export type TestConnectionResult = {
  ok: boolean
  username?: string
  botId?: number
  error?: string
  state: BridgeState
}

export type ExportLogsResult = {
  fileName: string
  text: string
}

// What the audit trail records. Telegram side: commands and buttons that change or run something,
// failure buttons, and every refusal by role. Panel side: access, roles and token changes.
export type AuditAction =
  | 'run'
  | 'sync'
  | 'new'
  | 'home'
  | 'bind'
  | 'rename'
  | 'retry'
  | 'details'
  | 'refused'
  | 'access'
  | 'roles'
  | 'token'
  | 'allow'
  | 'bridgeAdded'
  | 'bridgeRemoved'

// One audit entry: who did what, where, with which role, and whether it was done. Never message
// text, tokens or keys. Kept 90 days, at most 2000 entries across bridges, also after a bridge is
// removed.
export type AuditEntry = {
  id: string
  at: number
  bridgeId: string
  // 'telegram': a person on Telegram; 'panel': the owner in Orca's panel.
  source: 'telegram' | 'panel'
  // Telegram user id and label ("@joao" or "Ann (123)"); absent for the panel.
  userId?: string
  userLabel?: string
  chatId?: string
  roleName?: string
  action: AuditAction
  // What it acted on: the automation name, the command, "on"/"off", or the changed field names.
  target?: string
  result: 'done' | 'refused'
}

export type AuditQuery = {
  // Absent: every bridge.
  bridgeId?: string
  action?: AuditAction
  result?: 'done' | 'refused'
}

// The Orca bot selected in Orca's sidebar. `none`: Orca answered and the focus is not a bot (no
// workspace, a worktree, a folder without bot.json). `unknown`: the worker could not find out.
export type FocusedBot =
  | { kind: 'bot'; bot: { id: string; name: string } }
  | { kind: 'none' }
  | { kind: 'unknown'; reason: string }

declare module 'orca' {
  interface PluginRequests {
    'bridge.getState': { output: BridgeState }
    // A new bridge starts without a token and switched off; `orcaBot` pins it to that Orca bot.
    'bridge.add': {
      input: { name?: string; orcaBot?: string }
      output: { bridgeId: string; state: BridgeState }
    }
    'bridge.remove': { input: { bridgeId: string }; output: BridgeState }
    'bridge.saveConfig': { input: SaveConfigInput; output: BridgeState }
    'bridge.testConnection': { input: { bridgeId: string }; output: TestConnectionResult }
    'bridge.setEnabled': { input: { bridgeId: string; enabled: boolean }; output: BridgeState }
    'bridge.allowUserId': { input: { bridgeId: string; userId: string }; output: BridgeState }
    'bridge.resetBinding': { input: { bridgeId: string; tgChatId: string }; output: BridgeState }
    'bridge.clearLogs': { output: BridgeState }
    'bridge.setDebugLogging': { input: { enabled: boolean }; output: BridgeState }
    'bridge.exportLogs': { output: ExportLogsResult }
    'bridge.focusedBot': { output: FocusedBot }
    // Orca's automations, for a role's "may run only these" list.
    'bridge.listAutomations': { output: { id: string; name: string }[] }
    // Newest first, at most 500 per answer.
    'bridge.listAudit': { input: AuditQuery; output: { entries: AuditEntry[]; total: number } }
    // CSV of the matching entries, for files.saveAs.
    'bridge.exportAudit': { input: AuditQuery; output: ExportLogsResult }
  }
  interface PluginPanelEvents {
    'bridge.stateChanged': BridgeState
  }
}
