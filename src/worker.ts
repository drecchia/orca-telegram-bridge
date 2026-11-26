import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import {
  LANGUAGE_NAMES,
  languageFromTelegramCode,
  normalizeLanguageSetting,
  REPLY_LANGUAGES,
  t,
  TELEGRAM_COMMAND_NAMES,
  type Messages,
  type ReplyLanguage,
  type TelegramCommandName
} from './i18n'
import {
  computeTailHashes,
  createOrcaCliRunner,
  dispatchToOrcaBotAndWait,
  DispatchTimeoutError,
  extractMessageItems,
  findUnsyncedTail,
  getOrcaBinary,
  isOrcaAutomationRunMessage,
  isOrcaOrchestrationMailMessage,
  isTelegramOriginatedUserMessage,
  OrcaCliError,
  pickPluginKey,
  type OrcaAutomationRun,
  type OrcaAutomationSummary,
  type OrcaCliRunner,
  type OrcaMessageItem,
  withoutQuietMarker
} from './orca-bridge'
import {
  extractAttachments,
  loadLocalAttachment,
  type AttachmentProblem,
  type OutboundAttachment
} from './outbound-media'
import type {
  AuditAction,
  AuditEntry,
  AuditQuery,
  BotSummary,
  BridgeConfig,
  BridgeConnectionStatus,
  BridgeLogEntry,
  BridgeState,
  BridgeView,
  ChatBinding,
  ExportLogsResult,
  FocusedBot,
  LogScope,
  SaveConfigInput,
  TestConnectionResult
} from './protocol'
import {
  defaultRoles,
  FULL_ROLE_ID,
  MEMBER_ROLE_ID,
  normalizeRoleAssignments,
  normalizeRoles,
  permissionForCallback,
  permissionForCommand,
  resolveRole,
  roleAllows,
  roleMayRun,
  type BridgeRole
} from './roles'
import {
  extractTablesFromMarkdown,
  renderTableToPng,
  type ExtractedTable
} from './table-render'
import {
  createTelegramClient,
  markdownToTelegramHtml,
  splitTelegramMessage,
  MAX_TELEGRAM_DOWNLOAD_BYTES,
  TelegramApiError,
  type TelegramAudio,
  type TelegramBotCommand,
  type TelegramBotCommandScope,
  type TelegramCallbackQuery,
  type TelegramChat,
  type TelegramChatMemberUpdated,
  type TelegramClient,
  type TelegramDocument,
  type TelegramInlineKeyboardButton,
  type TelegramInlineKeyboardMarkup,
  type TelegramMessage,
  type TelegramUpdate,
  type TelegramUser
} from './telegram-api'
import {
  DEFAULT_VOICE_MODELS,
  MAX_TRANSCRIBE_BYTES,
  transcribeAudio,
  type Transcriber
} from './transcribe'

// Each bridge's token is the secret `botToken.<id>`, its voice API key `voiceKey.<id>`; its runtime
// state lives under `tg.<id>.*`.
const STORAGE_BRIDGES = 'bridges'
const STORAGE_LOGS = 'tg.logs'
// One key for every bridge, not per bridge, so a removed bridge's entries stay.
const STORAGE_AUDIT = 'tg.audit'
// commandScopes: the user/group ids that got a command menu of their own, so a removed id's menu is deleted.
// knownNames: the names of the listed ids, shown next to them in the editor.
const BRIDGE_STORAGE_NAMES = ['offset', 'bindings', 'syncCursors', 'lastBlocked', 'chatLanguages', 'commandScopes', 'knownNames'] as const
// What 0.4.0 and earlier stored for their single bridge; moved into "Bridge 1" on the first start.
const LEGACY_SECRET_BOT_TOKEN = 'botToken'
// chatLanguages, commandScopes and knownNames came later, so 0.4.0 had nothing to move for them.
const LEGACY_STORAGE: Partial<Record<(typeof BRIDGE_STORAGE_NAMES)[number], string>> = {
  offset: 'tg.updateOffset',
  bindings: 'tg.bindings',
  syncCursors: 'tg.syncCursors',
  lastBlocked: 'tg.lastBlockedUserId'
}
const STATUS_BAR_ID = 'telegram-status'
const PANEL_ID = 'telegram-bridge'
// Stored ring of log entries; the state posted to the panel carries only the newest STATE_LOGS.
const MAX_LOGS = 200
const STATE_LOGS = 40
const AUDIT_KEEP_MS = 90 * 24 * 60 * 60 * 1000
const MAX_AUDIT = 2000
const AUDIT_PAGE = 500
const MAX_DETAIL_CHARS = 500
const MAX_LOG_DETAILS_CHARS = 3000
const MAX_STDERR_DETAIL_CHARS = 1500
const STACK_DETAIL_LINES = 8
// Frequent sync reads (`bot chats`, `agent read`) are traced only when slower than this or failing.
const SLOW_CLI_CALL_MS = 2000
const LOG_FLUSH_MS = 1000
const BLOCK_LOG_INTERVAL_MS = 60_000
const TRANSCRIBE_TIMEOUT_MS = 60_000
// Orca's page size for `automations runs`, and how recent a run must be to explain a chat message.
const AUTOMATION_RUNS_LIMIT = 100
const AUTOMATION_RUN_WINDOW_MS = 24 * 60 * 60 * 1000
// Clicking through bots in Orca's sidebar asks for the focused bot each time; the workspace list
// is reused this long so fast clicking does not ask Orca for it again and again.
const WORKSPACE_LIST_CACHE_MS = 5000
// A slow answer gets a "⏳ Working…" line after this long, edited at most this often while it lasts.
const WORKING_LINE_AFTER_MS = 20_000
const WORKING_LINE_EVERY_MS = 15_000
// How long a failed answer's [Try again] and [Details] keep working; in memory only.
const FAILED_ANSWER_TTL_MS = 30 * 60 * 1000

// A chat entry may differ from the stored prompt in line endings and outer whitespace.
function normalizePrompt(text: string): string {
  return text.replace(/\r\n/g, '\n').trim()
}

// Starts the text sent to the Orca bot in place of a voice message or audio file.
const VOICE_PREFIX = '[Voice message, transcribed]'

// With replyLanguage 'auto', the language of the Telegram user whose update is being handled. The
// async context carries it into the chat's queued work, so chats handled side by side never mix.
const messageLanguage = new AsyncLocalStorage<ReplyLanguage>()

// Telegram shows the menu set for the user's app language, else the default (no code) one.
const MENU_LANGUAGES: Array<[code: string, language: ReplyLanguage]> = [
  ['pt', 'pt-BR'],
  ['es', 'es'],
  ['zh', 'zh-CN']
]

type SyncCursor = {
  tailHashes: string[]
  lastActivityAt?: number
  pendingWorking?: boolean
}

export type BridgeDeps = {
  telegram: TelegramClient
  orcaCli: OrcaCliRunner
  renderTable?: (table: ExtractedTable) => Promise<Buffer | null>
  downloadDir?: string
  pollIntervalMs?: number
  outboundPollIntervalMs?: number
  retryBackoffMs?: number
  // Delay before stored logs are written; 0 writes on every entry (tests).
  logFlushMs?: number
  // Speech-to-text for voice messages; tests inject a fake.
  transcribe?: Transcriber
  // The working line's delay and edit interval, and how long a failure's buttons work (tests).
  workingLineAfterMs?: number
  workingLineEveryMs?: number
  failedAnswerTtlMs?: number
  // The clock for audit entries and their 90-day pruning (tests).
  now?: () => number
}

type IncomingTelegramImage = {
  fileId: string
  ext: string
}

const ALLOWED_IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'])
const IMAGE_EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp'
}

function extractIncomingImage(msg: TelegramMessage): IncomingTelegramImage | null {
  if (msg.photo && msg.photo.length > 0) {
    const largest = msg.photo.reduce((best, item) => {
      const bestScore = best.file_size ?? best.width * best.height
      const itemScore = item.file_size ?? item.width * item.height
      return itemScore >= bestScore ? item : best
    })
    return { fileId: largest.file_id, ext: '.jpg' }
  }
  if (msg.document && msg.document.mime_type?.toLowerCase().startsWith('image/')) {
    const docExt = msg.document.file_name
      ? path.extname(msg.document.file_name).toLowerCase()
      : ''
    const ext = ALLOWED_IMAGE_EXTS.has(docExt)
      ? docExt
      : IMAGE_EXT_BY_MIME[msg.document.mime_type?.toLowerCase() ?? '']
    // Other image types (SVG, HEIC, ...) are refused: saved under a wrong extension the agent cannot read them.
    return ext ? { fileId: msg.document.file_id, ext } : null
  }
  return null
}

function resolveSafeImageExt(filePath: string | undefined, fallbackExt: string): string {
  const fromPath = filePath ? path.extname(filePath).toLowerCase() : ''
  return ALLOWED_IMAGE_EXTS.has(fromPath) ? fromPath : fallbackExt
}

// The name a downloaded file is saved under: Telegram's file name with every char outside
// [A-Za-z0-9._-] replaced, so no path separator survives and the file stays in its folder; at most
// 80 chars, keeping the extension. No name: "file" plus the extension of Telegram's own path.
function safeDocumentName(fileName: string | undefined, telegramPath: string): string {
  const name = (fileName || `file${path.extname(telegramPath)}`).replace(/[^A-Za-z0-9._-]/g, '_')
  if (name.length <= 80) return name
  const ext = path.extname(name).slice(0, 16)
  return name.slice(0, 80 - ext.length) + ext
}

// For the logs: a document's extension and size, never its name.
function describeDocument(doc: TelegramDocument): string {
  const ext = path.extname(doc.file_name ?? '').toLowerCase().replace(/[^a-z0-9._-]/g, '_').slice(0, 16)
  return `document ${ext || '(no extension)'} ${doc.file_size ?? 'unknown'} bytes`
}

// User ids are positive; group and supergroup chat ids are negative.
function parseAllowedIds(raw: string): Set<string> {
  return new Set(
    raw
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter((s) => /^-?\d+$/.test(s))
  )
}

// An open bridge lets everyone in; a restricted one only the listed sender or chat (none while
// the list is empty).
function isAllowed(restricted: boolean, allowed: Set<string>, fromId: string, tgChatId: string): boolean {
  return !restricted || allowed.has(fromId) || allowed.has(tgChatId)
}

// The ids whose names are kept: the allowlist and everyone with a role, so strangers on an open
// bridge are never stored.
function listedIds(config: Pick<BridgeConfig, 'allowedUserIds' | 'roleAssignments'>): Set<string> {
  const ids = parseAllowedIds(config.allowedUserIds)
  for (const id of Object.keys(config.roleAssignments)) {
    if (/^-?\d+$/.test(id)) ids.add(id)
  }
  return ids
}

// "@username", else "First Last"; '' when Telegram gave neither.
function personName(person: { username?: string; first_name?: string; last_name?: string }): string {
  if (person.username) return `@${person.username}`
  return [person.first_name, person.last_name].filter(Boolean).join(' ').trim()
}

// getChat calls per connect or save, so a long list cannot flood Telegram.
const MAX_NAME_LOOKUPS = 50

// Orca titles a chat it opens for a handoff from the subject ("Telegram: <first words>"), sometimes
// behind the sender ("your owner's agent: Telegram: …"). Only such a title is replaced, so a name
// given with /rename or in Orca stays.
function isAutomaticChatTitle(title: string | undefined): boolean {
  return title !== undefined && /^(your owner's agent: )?Telegram: /.test(title)
}

// "telegram@drecchia" for a person, "telegram@Ana Souza" without a username, "telegram@Ops Team"
// for a group. Empty when Telegram gave no name.
function orcaChatNameFor(msg: Pick<TelegramMessage, 'from' | 'chat'>): string {
  const name = msg.chat.type === 'private' ? (msg.from ? personName(msg.from) : '') : (msg.chat.title ?? '').trim()
  if (!name) return ''
  return name.startsWith('@') ? `telegram${name}` : `telegram@${name}`
}

// The menu commands a role may use in a private chat or in a group; /help is always one of them.
function commandsForRole(role: BridgeRole, isGroup: boolean): TelegramCommandName[] {
  return TELEGRAM_COMMAND_NAMES.filter((name) => roleAllows(role, permissionForCommand(`/${name}`, isGroup)))
}

// Everything the Telegram command menus depend on; a change means they must be sent again.
function menuKey(config: BridgeConfig): string {
  return JSON.stringify([
    config.replyLanguage,
    config.restricted,
    config.roles,
    config.roleAssignments
  ])
}

// Removes text[start, end) and the space it leaves behind: 'a @bot b' -> 'a b', 'hi @bot, x' -> 'hi, x'.
function cutSpan(text: string, start: number, end: number): string {
  const before = text.slice(0, start)
  const after = text.slice(end)
  if (!/\s$/.test(before)) return before + after
  if (/^\s/.test(after)) return before + after.slice(1)
  return /^[,.!?;:]/.test(after) ? before.slice(0, -1) + after : before + after
}

// Finds '@username' mentions of this bot: from the message entities when Telegram sent them,
// else by plain text. Returns the text without those mentions.
function stripBotMention(
  msg: TelegramMessage,
  username: string
): { mentioned: boolean; text: string } {
  const raw = msg.text ?? msg.caption ?? ''
  const handle = `@${username.toLowerCase()}`
  const entities = (msg.text !== undefined ? msg.entities : msg.caption_entities) ?? []
  const starts = entities
    .filter(
      (e) =>
        e.type === 'mention' && raw.slice(e.offset, e.offset + e.length).toLowerCase() === handle
    )
    .map((e) => e.offset)
  if (starts.length === 0) {
    const pattern = new RegExp(`(?<![\\w@])@${username}(?!\\w)`, 'gi')
    let match: RegExpExecArray | null
    while ((match = pattern.exec(raw)) !== null) starts.push(match.index)
  }
  starts.sort((a, b) => b - a)
  let text = raw
  for (const start of starts) text = cutSpan(text, start, start + handle.length)
  return { mentioned: starts.length > 0, text: text.trim() }
}

function formatSenderLabel(msg: Pick<TelegramMessage, 'from' | 'chat'>): string {
  const from = msg.from
  if (!from) return `chat:${msg.chat.id}`
  if (from.username) return `@${from.username}`
  return `${from.first_name} (${from.id})`
}

function truncateText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

// Orca refuses `undefined` (and NaN) anywhere in a storage value (invalid_params "Invalid input") and
// in a panel answer ("answered with a non-JSON value"). Optional fields such as a binding's botId are
// often unset, so drop them as JSON would.
function toPlainJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

type ErrorContext = Record<string, string | number | boolean | null | undefined>
type DispatchParams = Parameters<typeof dispatchToOrcaBotAndWait>[1]
type DispatchResult = Awaited<ReturnType<typeof dispatchToOrcaBotAndWait>>
// `sent` turns true once sendToBot resolved: from then on the Orca bot has the message.
type DispatchStats = { startedAt: number; polls: number; lastState?: string; sent?: boolean }

// A failed answer remembered for its [Try again] and [Details] buttons, in memory only.
type FailedAnswer = {
  msg: TelegramMessage
  senderId: string
  updateId: number
  // Sends the same message (text or transcript, image paths) again. Absent when it may have reached
  // the Orca bot: its turn may still be running, and a second run could repeat a risky request.
  rerun?: (signal: AbortSignal | undefined) => Promise<void>
  // The technical cause for [Details], redacted and truncated as the reply used to show it.
  detail: string
  expiresAt: number
}
type AutomationSnapshot = { runs: OrcaAutomationRun[]; automations: OrcaAutomationSummary[] }

function indentLines(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')
}

function errorFieldLines(err: Error): string[] {
  if (err instanceof OrcaCliError) {
    const lines = [
      `command: orca ${err.args.join(' ')}`,
      `kind: ${err.kind}`,
      `exit code: ${err.exitCode ?? 'none'}`,
      `duration: ${err.durationMs} ms`,
      `stdout: ${err.stdoutBytes} bytes`
    ]
    // An exit error's message already is its stderr.
    if (err.stderr && err.stderr !== err.message) {
      lines.push('stderr:', indentLines(truncateText(err.stderr, MAX_STDERR_DETAIL_CHARS)))
    }
    return lines
  }
  if (err instanceof TelegramApiError) {
    const lines = [
      `method: ${err.method ?? 'unknown'}`,
      `HTTP status: ${err.statusCode}`,
      `retryable: ${err.retryable}`
    ]
    if (err.retryAfterSec !== undefined) lines.push(`retry after: ${err.retryAfterSec} s`)
    return lines
  }
  const code = 'code' in err ? err.code : undefined
  return typeof code === 'string' || typeof code === 'number' ? [`code: ${code}`] : []
}

// The `details` of a log entry: class and message, the error's own fields, its causes, the call
// context and the top of the stack. appendLog redacts and caps it.
function describeError(err: unknown, context?: ErrorContext): string {
  const lines: string[] = []
  let current: unknown = err
  for (let depth = 0; current !== undefined && current !== null && depth < 4; depth++) {
    const prefix = depth === 0 ? '' : 'caused by: '
    if (!(current instanceof Error)) {
      lines.push(`${prefix}${String(current)}`)
      break
    }
    lines.push(
      `${prefix}${current.name}: ${truncateText(current.message, MAX_STDERR_DETAIL_CHARS)}`,
      ...errorFieldLines(current)
    )
    current = current.cause
  }
  for (const [key, value] of Object.entries(context ?? {})) {
    if (value !== undefined) lines.push(`${key}=${value}`)
  }
  const stack =
    err instanceof Error && err.stack
      ? err.stack
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.startsWith('at '))
          .slice(0, STACK_DETAIL_LINES)
      : []
  if (stack.length > 0) lines.push('stack:', ...stack.map((line) => `  ${line}`))
  return lines.join('\n')
}

// Callback data carries ids and names after its "<kind>:" prefix; only the prefix is logged.
function callbackDataKind(data: string | undefined): string | undefined {
  return data === undefined ? undefined : `${data.split(':')[0]}:`
}

// Roles and assignments are objects, so fields are compared by value.
function changedConfigFields(prev: BridgeConfig, next: BridgeConfig): string[] {
  return (Object.keys(next) as (keyof BridgeConfig)[]).filter(
    (key) => key !== 'hasToken' && JSON.stringify(prev[key]) !== JSON.stringify(next[key])
  )
}

// "restricted; added 42, 43; removed 7": the access mode when it changed, then the ids. Telegram ids
// are not secrets. Null when the save left access as it was.
function accessChange(prev: BridgeConfig, next: BridgeConfig): string | null {
  const before = parseAllowedIds(prev.allowedUserIds)
  const after = parseAllowedIds(next.allowedUserIds)
  const added = [...after].filter((id) => !before.has(id))
  const removed = [...before].filter((id) => !after.has(id))
  const parts: string[] = []
  if (prev.restricted !== next.restricted) parts.push(next.restricted ? 'restricted' : 'open')
  if (added.length > 0) parts.push(`added ${added.join(', ')}`)
  if (removed.length > 0) parts.push(`removed ${removed.join(', ')}`)
  return parts.length > 0 ? parts.join('; ') : null
}

// What a save changed in the roles, by role name ("prompt: Member", "permissions: Ops", "added: QA",
// "removed: QA", "name: Helper"), then "assignments" when who has which role changed. Never the
// prompt text. Null when the save left roles as they were.
function roleChanges(prev: BridgeConfig, next: BridgeConfig): string | null {
  const before = new Map(prev.roles.map((role) => [role.id, role]))
  const after = new Set(next.roles.map((role) => role.id))
  const parts: string[] = []
  for (const role of next.roles) {
    const old = before.get(role.id)
    if (!old) {
      parts.push(`added: ${role.name}`)
      continue
    }
    if (old.name !== role.name) parts.push(`name: ${role.name}`)
    if (old.prompt !== role.prompt) parts.push(`prompt: ${role.name}`)
    // The automation list is part of what the role may do.
    const may = (r: BridgeRole) => JSON.stringify([r.permissions, r.runAutomationIds])
    if (may(old) !== may(role)) parts.push(`permissions: ${role.name}`)
  }
  for (const role of prev.roles) if (!after.has(role.id)) parts.push(`removed: ${role.name}`)
  // Compared without key order, which a save may not keep.
  const assignments = (value: Record<string, string>) => JSON.stringify(Object.entries(value).sort())
  if (assignments(prev.roleAssignments) !== assignments(next.roleAssignments)) parts.push('assignments')
  return parts.length > 0 ? parts.join(', ') : null
}

function maskProxyCredentials(proxyUrl: string): string {
  return proxyUrl.replace(/\/\/[^/@]*@/, '//<redacted>@')
}

function fileTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours()
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

type PluginInfo = { name: string; version: string; id: string | null; key: string | null }

async function readPluginInfo(): Promise<PluginInfo> {
  try {
    const raw = JSON.parse(
      await fs.readFile(new URL('../orca-plugin.json', import.meta.url), 'utf8')
    ) as { name?: unknown; version?: unknown; id?: unknown; publisher?: unknown }
    const id = typeof raw.id === 'string' ? raw.id : null
    return {
      name: typeof raw.name === 'string' ? raw.name : 'unknown',
      version: typeof raw.version === 'string' ? raw.version : 'unknown',
      id,
      // Orca keys an installed plugin as `<publisher>.<id>`; `orca plugin open` needs that key.
      key: typeof raw.publisher === 'string' && id ? `${raw.publisher}.${id}` : null
    }
  } catch {
    // The manifest is not readable where this module was loaded from.
    return { name: 'unknown', version: 'unknown', id: null, key: null }
  }
}

type BridgeStorageName = (typeof BRIDGE_STORAGE_NAMES)[number]

function bridgeStorageKey(bridgeId: string, name: BridgeStorageName): string {
  return `tg.${bridgeId}.${name}`
}

function bridgeSecretKey(bridgeId: string): string {
  return `botToken.${bridgeId}`
}

function voiceSecretKey(bridgeId: string): string {
  return `voiceKey.${bridgeId}`
}

const BRIDGE_ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'

function newBridgeId(taken: Set<string>): string {
  for (;;) {
    let id = 'b-'
    for (let i = 0; i < 8; i++) id += BRIDGE_ID_CHARS[Math.floor(Math.random() * BRIDGE_ID_CHARS.length)]
    if (!taken.has(id)) return id
  }
}

// A bridge's config as stored in `bridges`: everything but the token and voice key, which are secrets.
type StoredBridge = Omit<BridgeConfig, 'hasToken' | 'hasVoiceKey'>

function clampTimeout(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 300
  return Math.min(1800, Math.max(30, Math.round(n)))
}

// Bridges read from a store written before roles existed. Their people who chatted before also keep
// full access, but bindings load later (loadRuntimeState), so the runtime finishes the migration.
const storedBeforeRoles = new WeakSet<StoredBridge>()

// Reads one stored bridge, or a 0.4.0 settings object; a missing or wrong-typed field takes its default.
// Groups default to on: 0.4.0 answered in groups, and so did bridges stored before group options.
function readStoredBridge(raw: Record<string, unknown>, id: string, fallbackName: string): StoredBridge {
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
  const allowedUserIds = text(raw.allowedUserIds)
  const roles = normalizeRoles(raw.roles)
  // Stored before roles existed: everyone already allowed keeps full access, so nobody loses rights
  // on update, until the owner reviews the roles and saves.
  const beforeRoles = raw.roles === undefined
  const stored: StoredBridge = {
    id,
    name: text(raw.name) || fallbackName,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : false,
    orcaBot: text(raw.orcaBot),
    // Stored before the access mode was kept apart from the list: a listed ID meant restricted.
    restricted: typeof raw.restricted === 'boolean' ? raw.restricted : parseAllowedIds(allowedUserIds).size > 0,
    allowedUserIds,
    roles,
    roleAssignments: beforeRoles
      ? Object.fromEntries([...parseAllowedIds(allowedUserIds)].map((userId) => [userId, FULL_ROLE_ID]))
      : normalizeRoleAssignments(raw.roleAssignments, roles),
    rolesReviewed: beforeRoles ? false : typeof raw.rolesReviewed === 'boolean' ? raw.rolesReviewed : true,
    groupAuditNotice: typeof raw.groupAuditNotice === 'boolean' ? raw.groupAuditNotice : false,
    proxyUrl: text(raw.proxyUrl),
    replyTimeoutSec: clampTimeout(raw.replyTimeoutSec),
    syncOrcaOutbound: typeof raw.syncOrcaOutbound === 'boolean' ? raw.syncOrcaOutbound : false,
    replyLanguage: normalizeLanguageSetting(raw.replyLanguage),
    allowGroups: typeof raw.allowGroups === 'boolean' ? raw.allowGroups : true,
    groupMode: raw.groupMode === 'all' ? 'all' : 'addressed',
    // Before 0.8.0, 'all' answered every group message; such a bridge keeps answering ('helpful').
    groupReply:
      raw.groupReply === 'helpful' || raw.groupReply === 'mentioned'
        ? raw.groupReply
        : raw.groupMode === 'all'
          ? 'helpful'
          : 'mentioned',
    voiceEnabled: typeof raw.voiceEnabled === 'boolean' ? raw.voiceEnabled : false,
    voiceProvider: raw.voiceProvider === 'openai' ? 'openai' : 'openrouter',
    voiceModel: text(raw.voiceModel)
  }
  if (beforeRoles) storedBeforeRoles.add(stored)
  return stored
}

function isGroupChat(chat: TelegramChat): boolean {
  return chat.type === 'group' || chat.type === 'supergroup'
}

type LogFn = (
  level: BridgeLogEntry['level'],
  scope: LogScope,
  message: string,
  details?: string
) => Promise<void>

// Where traced calls record their debug entries: the bridge's own log, or the plugin-wide one.
type Tracer = { enabled: () => boolean; log: LogFn }

// Times one Telegram/CLI call into a debug entry. A failure is recorded with its error; the
// caller's own entry adds the context. `summary` returning null skips a success entry.
async function traceCall<T>(
  tracer: Tracer,
  scope: LogScope,
  call: string,
  run: () => Promise<T>,
  summary: (result: T, ms: number) => string | null
): Promise<T> {
  if (!tracer.enabled()) return run()
  const startedAt = Date.now()
  let result: T
  try {
    result = await run()
  } catch (err) {
    await tracer.log('debug', scope, `${call} failed after ${Date.now() - startedAt} ms`, describeError(err))
    throw err
  }
  const ms = Date.now() - startedAt
  const text = summary(result, ms)
  if (text !== null) {
    await tracer.log('debug', scope, `${call} ok in ${ms} ms${text ? `: ${text}` : ''}`)
  }
  return result
}

// Only ids, sizes and counts are recorded: never message text, captions or callback data.
function traceTelegram(client: TelegramClient, tracer: Tracer): TelegramClient {
  const trace = <T>(
    call: string,
    run: () => Promise<T>,
    summary: (result: T, ms: number) => string | null = () => ''
  ) => traceCall(tracer, 'telegram', call, run, summary)
  return {
    getMe: (token, options) =>
      trace('getMe', () => client.getMe(token, options), (me) => `@${me.username ?? me.id}`),
    setMyCommands: (token, commands, options, languageCode, scope) =>
      trace(
        `setMyCommands (${commands.length} commands${languageCode ? `, ${languageCode}` : ''}${scope ? `, chat ${scope.chat_id}` : ''})`,
        () => client.setMyCommands(token, commands, options, languageCode, scope)
      ),
    deleteMyCommands: (token, options, scope, languageCode) =>
      trace(
        `deleteMyCommands (${scope ? `chat ${scope.chat_id}` : 'default'}${languageCode ? `, ${languageCode}` : ''})`,
        () => client.deleteMyCommands(token, options, scope, languageCode)
      ),
    getUpdates: (token, params, options) =>
      trace(
        `getUpdates offset=${params.offset ?? 0} timeout=${params.timeoutSec ?? 25}s`,
        () => client.getUpdates(token, params, options),
        // Empty long polls are the idle steady state.
        (updates) => (updates.length > 0 ? `${updates.length} update(s)` : null)
      ),
    sendMessage: (token, params, options) =>
      trace(
        `sendMessage chat=${params.chatId} ${params.text.length} chars${params.parseMode ? ` ${params.parseMode}` : ''}`,
        () => client.sendMessage(token, params, options),
        (sent) => `message ${sent.message_id}`
      ),
    answerCallbackQuery: (token, params, options) =>
      trace('answerCallbackQuery', () => client.answerCallbackQuery(token, params, options)),
    sendPhoto: (token, params, options) =>
      trace(
        `sendPhoto chat=${params.chatId} ${typeof params.photo === 'string' ? 'by URL' : `${params.photo.length} bytes`}`,
        () => client.sendPhoto(token, params, options),
        (sent) => `message ${sent.message_id}`
      ),
    sendDocument: (token, params, options) =>
      trace(
        `sendDocument chat=${params.chatId} ${typeof params.document === 'string' ? 'by URL' : `${params.document.length} bytes`}`,
        () => client.sendDocument(token, params, options),
        (sent) => `message ${sent.message_id}`
      ),
    sendChatAction: (token, params, options) =>
      trace(`sendChatAction chat=${params.chatId} ${params.action}`, () =>
        client.sendChatAction(token, params, options)
      ),
    getFile: (token, fileId, options) =>
      trace(
        'getFile',
        () => client.getFile(token, fileId, options),
        (file) => `${file.file_size ?? 'unknown'} bytes`
      ),
    downloadFile: (token, filePath, options) =>
      trace(
        'downloadFile',
        () => client.downloadFile(token, filePath, options),
        (bytes) => `${bytes.length} bytes`
      ),
    leaveChat: (token, chatId, options) =>
      trace(`leaveChat chat=${chatId}`, () => client.leaveChat(token, chatId, options)),
    getChat: (token, chatId, options) => trace(`getChat chat=${chatId}`, () => client.getChat(token, chatId, options)),
    editMessageText: (token, params, options) =>
      trace(`editMessageText chat=${params.chatId} message=${params.messageId} ${params.text.length} chars`, () =>
        client.editMessageText(token, params, options)
      ),
    deleteMessage: (token, chatId, messageId, options) =>
      trace(`deleteMessage chat=${chatId} message=${messageId}`, () =>
        client.deleteMessage(token, chatId, messageId, options)
      )
  }
}

// Commands are logged without text values (chat titles, subjects) or the stdin body.
function traceOrcaCli(cli: OrcaCliRunner, tracer: Tracer): OrcaCliRunner {
  const trace = <T>(
    call: string,
    run: () => Promise<T>,
    summary: (result: T, ms: number) => string | null = () => ''
  ) => traceCall(tracer, 'orca-cli', call, run, summary)
  // Sync ticks read every few seconds; their successes are recorded only when slow.
  const whenSlow = (ms: number, text: string) => (ms > SLOW_CLI_CALL_MS ? text : null)
  return {
    listBots: () => trace('orca bot list', () => cli.listBots(), (bots) => `${bots.length} bot(s)`),
    listBotChats: (botName) =>
      trace(
        `orca bot chats --bot ${botName}`,
        () => cli.listBotChats(botName),
        (chats, ms) => whenSlow(ms, `${chats.length} chat(s)`)
      ),
    readSession: (sessionId, limit) =>
      trace(
        `orca agent read ${sessionId}`,
        () => cli.readSession(sessionId, limit),
        (session, ms) => whenSlow(ms, `${session.entries.length} entries, state ${session.state ?? 'unknown'}`)
      ),
    renameChat: (sessionId, name) =>
      trace(`orca chat rename --session ${sessionId}`, () => cli.renameChat(sessionId, name)),
    listAutomations: () =>
      trace('orca automations list', () => cli.listAutomations(), (list) => `${list.length} automation(s)`),
    runAutomation: (id) => trace(`orca automations run ${id}`, () => cli.runAutomation(id)),
    listAutomationRuns: (limit) =>
      trace(`orca automations runs --limit ${limit}`, () => cli.listAutomationRuns(limit), (runs) => `${runs.length} run(s)`),
    sendToBot: (params) =>
      trace(
        `orca orchestration send --to bot:${params.botName} --chat ${params.chatId}`,
        () => cli.sendToBot(params),
        () => `body ${params.body.length} chars`
      ),
    openPanel: (pluginKey, panelId) =>
      trace(`orca plugin open ${pluginKey} --panel ${panelId}`, () => cli.openPanel(pluginKey, panelId)),
    listPlugins: () =>
      trace('orca plugin list', () => cli.listPlugins(), (plugins) => `${plugins.length} plugin(s)`)
  }
}

// One bridge: one Telegram bot token, polled on its own, pinned to one Orca bot. A failure here
// (401, proxy, CLI) stays here; the manager runs every bridge side by side.
export class BridgeRuntime {
  readonly id: string
  private readonly manager: BridgeManager
  private readonly orca: OrcaWorkerApi
  private readonly deps: BridgeDeps

  private status: BridgeConnectionStatus = 'needs_token'
  private botUsername: string | null = null
  private botUserId: number | null = null
  private botDisplayName: string | null = null
  // What @BotFather allows this bot, from its last getMe.
  private telegramCaps: BridgeView['telegramCaps'] = null
  private lastError: string | null = null
  private lastBlockedUserId: string | null = null
  private lastPollAt: number | null = null
  private bindings: ChatBinding[] = []
  private syncCursors: Record<string, SyncCursor> = {}
  private updateOffset = 0
  private config: BridgeConfig
  // The pinned Orca bot's id when last seen, so a rename in Orca keeps the bridge on that bot.
  private pinnedBotId: string | null = null

  private cachedToken: string | null = null
  // The token that updateOffset, botUsername and commandsRegistered belong to.
  private identityToken: string | null = null
  private cachedVoiceKey: string | null = null
  // deps.transcribe (or the real one), traced like the Telegram and CLI calls.
  private readonly transcribe: Transcriber
  private commandsRegistered = false
  // The user/group ids whose own command menu is set (stored as commandScopes), and those whose menu
  // Telegram refused (it knows no chat with a person until they write to the bot).
  private commandScopeIds: string[] = []
  private unsetScopeIds = new Set<string>()
  // Read from a store written before roles: finish the migration once the bindings are loaded.
  private seedRolesFromBindings: boolean
  private pollAbort: AbortController | null = null
  private pollLoopPromise: Promise<void> | null = null
  private outboundLoopPromise: Promise<void> | null = null
  private outboundLoopAbort: AbortController | null = null
  private readonly chatQueues = new Map<string, Promise<void>>()
  private readonly activeTelegramTgChats = new Set<string>()
  private readonly activeTelegramOrcaChats = new Set<string>()
  // With 'auto': the last Telegram language of each allowed chat, kept in storage (chatLanguages).
  private readonly chatLanguages = new Map<string, ReplyLanguage>()
  private automationSnapshot: Promise<AutomationSnapshot | null> | null = null
  private readonly blockedLoggedAt = new Map<string, number>()
  // Groups this run already left because groups are off; a message there does not leave again.
  private readonly leftGroups = new Set<string>()
  private outboundSyncRunning = false
  private disposed = false
  private configOp: Promise<unknown> = Promise.resolve()
  // Failures retried every few seconds (sync ticks, secrets, command menu) by site:
  // logged once until their message changes or the call succeeds again.
  private readonly lastFailures = new Map<string, string>()
  // Failed answers by the id in their buttons' callback data (x:<id>, d:<id>).
  private readonly failedAnswers = new Map<string, FailedAnswer>()
  // Chats already warned that a working line could not be deleted.
  private readonly workingLineWarned = new Set<string>()
  // The names of the listed ids (stored as knownNames), and the queue of getChat runs that fill them in.
  private readonly knownNames = new Map<string, string>()
  private nameLookups: Promise<void> = Promise.resolve()

  constructor(manager: BridgeManager, stored: StoredBridge) {
    this.manager = manager
    this.orca = manager.orca
    this.id = stored.id
    this.config = { ...stored, hasToken: false, hasVoiceKey: false }
    this.seedRolesFromBindings = storedBeforeRoles.has(stored)
    const tracer: Tracer = {
      enabled: () => manager.debugLogging,
      log: (level, scope, message, details) => this.appendLog(level, scope, message, details)
    }
    this.deps = {
      ...manager.deps,
      telegram: traceTelegram(manager.deps.telegram, tracer),
      orcaCli: traceOrcaCli(manager.deps.orcaCli, tracer)
    }
    const transcribe = manager.deps.transcribe ?? transcribeAudio
    // Provider, model and size only: never the transcript.
    this.transcribe = (params) =>
      traceCall(tracer, 'bridge', 'transcribe', () => transcribe(params), () =>
        `${params.provider} ${params.model || DEFAULT_VOICE_MODELS[params.provider]}, ${params.audio.length} bytes`
      )
  }

  async init(): Promise<void> {
    this.cachedToken = await this.readToken()
    this.config.hasToken = Boolean(this.cachedToken)
    this.cachedVoiceKey = await this.readVoiceKey()
    this.config.hasVoiceKey = Boolean(this.cachedVoiceKey)
    await this.loadRuntimeState()
    this.identityToken = this.cachedToken
    this.updateInitialStatus()
    if (this.config.hasToken && this.config.enabled) {
      this.startPolling()
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.stopPolling()
  }

  get name(): string {
    return this.config.name
  }

  // The Orca bot name this bridge is pinned to ('' = the first Orca bot found).
  get orcaBot(): string {
    return this.config.orcaBot
  }

  // Switched on and able to poll.
  get active(): boolean {
    return this.config.enabled && this.config.hasToken
  }

  get hasToken(): boolean {
    return this.config.hasToken
  }

  get connectionStatus(): BridgeConnectionStatus {
    return this.status
  }

  get username(): string | null {
    return this.botUsername
  }

  stored(): StoredBridge {
    const { hasToken: _hasToken, hasVoiceKey: _hasVoiceKey, ...stored } = this.config
    return stored
  }

  view(): BridgeView {
    return {
      id: this.id,
      name: this.config.name,
      status: this.status,
      polling: this.pollAbort !== null,
      botUsername: this.botUsername,
      botDisplayName: this.botDisplayName,
      lastError: this.lastError,
      lastBlockedUserId: this.lastBlockedUserId,
      lastPollAt: this.lastPollAt,
      config: { ...this.config },
      bindings: [...this.bindings].sort((a, b) => b.updatedAt - a.updatedAt),
      telegramCaps: this.telegramCaps,
      knownNames: Object.fromEntries(this.knownNames)
    }
  }

  // Every token this bridge holds or still polls with; the manager redacts them all.
  tokens(): string[] {
    return [this.cachedToken, this.identityToken].filter((t): t is string => Boolean(t))
  }

  usesToken(token: string): boolean {
    return this.cachedToken === token || this.identityToken === token
  }

  // The voice API key, redacted by the manager like the tokens.
  voiceKeys(): string[] {
    return this.cachedVoiceKey ? [this.cachedVoiceKey] : []
  }

  // Texts for Telegram, in the language this bridge uses.
  private get i18n(): Messages {
    const setting = this.config.replyLanguage
    return t(setting === 'auto' ? (messageLanguage.getStore() ?? 'en') : setting)
  }

  private get bots(): BotSummary[] {
    return this.manager.bots
  }

  private key(name: BridgeStorageName): string {
    return bridgeStorageKey(this.id, name)
  }

  // Saves, switches and removal of this bridge run one after another, never interleaved.
  runConfigOp<T>(op: () => Promise<T>): Promise<T> {
    const run = this.configOp.then(op)
    this.configOp = run.catch(() => {})
    return run
  }

  saveConfig(input: SaveConfigInput): Promise<void> {
    return this.runConfigOp(() => this.saveConfigNow(input))
  }

  private async saveConfigNow(input: SaveConfigInput): Promise<void> {
    const prev = { ...this.config }
    const prevToken = this.cachedToken
    const prevVoiceKey = this.cachedVoiceKey
    if (input.clearToken) {
      try {
        await this.orca.secrets.delete(bridgeSecretKey(this.id))
      } catch (err) {
        await this.appendLog('debug', 'config', 'Deleting the stored bot token failed', describeError(err))
      }
      this.cachedToken = null
    } else if (input.botToken && input.botToken.trim()) {
      const cleanToken = input.botToken.trim()
      await this.orca.secrets.set(bridgeSecretKey(this.id), cleanToken)
      this.cachedToken = cleanToken
    }
    if (input.clearVoiceKey) {
      try {
        await this.orca.secrets.delete(voiceSecretKey(this.id))
      } catch (err) {
        await this.appendLog('debug', 'config', 'Deleting the stored voice API key failed', describeError(err))
      }
      this.retireVoiceKey()
    } else if (input.voiceApiKey && input.voiceApiKey.trim()) {
      const cleanKey = input.voiceApiKey.trim()
      await this.orca.secrets.set(voiceSecretKey(this.id), cleanKey)
      if (cleanKey !== this.cachedVoiceKey) this.retireVoiceKey()
      this.cachedVoiceKey = cleanKey
    }

    const replyLanguage =
      input.replyLanguage === undefined ? prev.replyLanguage : normalizeLanguageSetting(input.replyLanguage)
    const roles = input.roles === undefined ? prev.roles : normalizeRoles(input.roles)
    this.config = {
      id: this.id,
      name: input.name?.trim() || prev.name,
      hasToken: Boolean(this.cachedToken),
      enabled: input.enabled ?? prev.enabled,
      orcaBot: input.orcaBot.trim(),
      restricted: input.restricted,
      allowedUserIds: input.allowedUserIds.trim(),
      roles,
      // Assignments to a role that no longer exists are dropped.
      roleAssignments: normalizeRoleAssignments(input.roleAssignments ?? prev.roleAssignments, roles),
      rolesReviewed: input.roles !== undefined || input.roleAssignments !== undefined ? true : prev.rolesReviewed,
      groupAuditNotice: input.groupAuditNotice ?? prev.groupAuditNotice,
      proxyUrl: input.proxyUrl.trim(),
      replyTimeoutSec: clampTimeout(input.replyTimeoutSec || 300),
      syncOrcaOutbound: Boolean(input.syncOrcaOutbound),
      replyLanguage,
      allowGroups: input.allowGroups ?? prev.allowGroups,
      groupMode: input.groupMode === undefined ? prev.groupMode : input.groupMode === 'all' ? 'all' : 'addressed',
      groupReply:
        input.groupReply === undefined ? prev.groupReply : input.groupReply === 'helpful' ? 'helpful' : 'mentioned',
      voiceEnabled: input.voiceEnabled ?? prev.voiceEnabled,
      voiceProvider:
        input.voiceProvider === undefined ? prev.voiceProvider : input.voiceProvider === 'openai' ? 'openai' : 'openrouter',
      voiceModel: input.voiceModel === undefined ? prev.voiceModel : input.voiceModel.trim(),
      hasVoiceKey: Boolean(this.cachedVoiceKey)
    }
    await this.manager.saveBridges()
    await this.auditPanelSave(prev, prevToken)
    if (prev.orcaBot !== this.config.orcaBot) {
      this.pinnedBotId = null
    }
    if (menuKey(prev) !== menuKey(this.config)) {
      // The next poll registers the command menus again (language, access mode or roles changed).
      this.commandsRegistered = false
    }
    if (!prev.syncOrcaOutbound && this.config.syncOrcaOutbound) {
      await this.resetSyncCursors()
    }
    // A name is kept only while its id is listed.
    const listed = listedIds(this.config)
    const unlisted = [...this.knownNames.keys()].filter((id) => !listed.has(id))
    if (unlisted.length > 0) {
      for (const id of unlisted) this.knownNames.delete(id)
      await this.saveKnownNames()
    }
    this.lastError = null
    this.manager.refreshBotsInBackground()
    await this.appendLog('info', 'config', 'Configuration saved.')
    const changed = changedConfigFields(prev, this.config)
    if (prevToken !== this.cachedToken) changed.push('botToken')
    if (prevVoiceKey !== this.cachedVoiceKey) changed.push('voiceApiKey')
    await this.appendLog('debug', 'config', `Config changed: ${changed.join(', ') || 'nothing'}`)
    await this.logSyncPausedWhileOpen(changed)

    const tokenChanged = this.cachedToken !== this.identityToken
    // Restarting aborts in-flight replies, so restart only when the Telegram connection itself changes.
    if (tokenChanged || prev.proxyUrl !== this.config.proxyUrl || prev.enabled !== this.config.enabled) {
      await this.stopPolling()
    }
    await this.adoptToken(this.cachedToken)
    if (!this.config.hasToken) {
      this.status = 'needs_token'
      this.botUsername = null
      this.botUserId = null
      this.botDisplayName = null
      this.telegramCaps = null
    } else if (!this.config.enabled) {
      this.status = 'stopped'
    } else if (!this.pollAbort) {
      this.startPolling()
    } else if (this.config.syncOrcaOutbound) {
      this.ensureOutboundLoopStarted(this.pollAbort)
    }
    if (this.cachedToken) this.lookUpMissingNames(this.cachedToken)
    this.emitState()
  }

  async testConnection(): Promise<Omit<TestConnectionResult, 'state'>> {
    const token = await this.readToken()
    if (!token) {
      this.status = 'needs_token'
      this.lastError = 'Missing Telegram Bot Token.'
      this.emitState()
      return { ok: false, error: this.lastError }
    }

    try {
      const me = await this.deps.telegram.getMe(token, {
        proxyUrl: this.config.proxyUrl,
        timeoutMs: 12_000
      })
      this.rememberBot(me)
      this.lastError = null
      await this.ensureCommandsRegistered(token)
      if (this.status === 'error' || this.status === 'needs_token') {
        this.status = this.pollAbort ? 'connected' : 'stopped'
      }
      await this.appendLog('info', 'telegram', `Verified Telegram bot @${me.username || me.id}`)
      this.emitState()
      return { ok: true, ...(me.username ? { username: me.username } : {}), botId: me.id }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.lastError = message
      // While paused a failed test is not a polling failure; lastError alone reports it.
      if (this.pollAbort) {
        this.status = 'error'
      }
      await this.appendLog('error', 'telegram', `Telegram connection test failed: ${message}`, describeError(err))
      this.emitState()
      return { ok: false, error: message }
    }
  }

  setEnabled(enabled: boolean): Promise<void> {
    return this.runConfigOp(() => this.applyEnabled(enabled))
  }

  private async applyEnabled(nextEnabled: boolean): Promise<void> {
    if (!this.config.hasToken) {
      this.status = 'needs_token'
      this.lastError = 'Configure a Telegram Bot Token first.'
      this.emitState()
      return
    }
    if (nextEnabled === this.config.enabled && nextEnabled === Boolean(this.pollAbort)) {
      return
    }

    this.config.enabled = nextEnabled
    await this.manager.saveBridges()

    if (nextEnabled) {
      if (!this.pollAbort) this.startPolling()
      await this.appendLog('info', 'telegram', 'Telegram polling resumed.')
    } else {
      await this.stopPolling()
      this.status = 'stopped'
      await this.appendLog('info', 'telegram', 'Telegram polling paused.')
    }
    this.emitState()
  }

  async allowUserId(userId: string): Promise<void> {
    const clean = userId.trim()
    if (!/^-?\d+$/.test(clean)) {
      return
    }
    const existing = parseAllowedIds(this.config.allowedUserIds)
    existing.add(clean)
    this.config.allowedUserIds = Array.from(existing).join(', ')
    this.config.restricted = true
    // Allowed from the panel's Allow button: a Member, unless the owner already gave them a role.
    if (!this.config.roleAssignments[clean]) {
      this.config.roleAssignments = { ...this.config.roleAssignments, [clean]: MEMBER_ROLE_ID }
    }
    this.commandsRegistered = false
    await this.manager.saveBridges()
    if (this.lastBlockedUserId === clean) {
      this.lastBlockedUserId = null
      await this.orca.storage.set(this.key('lastBlocked'), null)
    }
    await this.appendLog('info', 'config', `Added Telegram user ${clean} to allowlist.`)
    await this.auditPanel('allow', clean)
    this.emitState()
  }

  async resetBinding(tgChatId: string): Promise<void> {
    // Queued behind a running reply, which would otherwise write the binding back when it ends.
    // The panel request does not wait for that reply; the state post after the reset updates it.
    const busy = this.chatQueues.has(tgChatId)
    const done = this.enqueueChatWork(tgChatId, async () => {
      this.bindings = this.bindings.filter((b) => b.tgChatId !== tgChatId)
      await this.orca.storage.set(this.key('bindings'), toPlainJson(this.bindings))
      await this.pruneUnusedSyncCursors()
      await this.appendLog('info', 'bridge', `Reset Orca chat binding for Telegram chat ${tgChatId}.`)
      this.emitState()
    })
    if (!busy) await done
  }

  // This bridge's part of the exported diagnostics header; the token is never in it.
  exportLines(): string[] {
    const config = { ...this.config, proxyUrl: maskProxyCredentials(this.config.proxyUrl) }
    return [
      `Bridge: ${this.config.name} (${this.id})`,
      `  Status: ${this.status}${this.pollAbort ? ' (polling)' : ''}`,
      `  Bot: ${this.botUsername ? `@${this.botUsername}` : 'unknown'}`,
      `  Last error: ${this.lastError ?? 'none'}`,
      `  Config: ${JSON.stringify(config)}`,
      `  Bindings: ${this.bindings.length}`
    ]
  }

  async handleIncomingUpdate(update: TelegramUpdate): Promise<void> {
    const accepted = await this.acceptIncomingUpdate(update, this.pollAbort?.signal)
    await accepted?.done
  }

  // Runs the update in a language 'auto' uses for everything it says: the sender's Telegram
  // language, else the one this chat showed before, else English.
  private acceptIncomingUpdate(
    update: TelegramUpdate,
    signal?: AbortSignal
  ): Promise<{ done: Promise<void> } | null> {
    const from = update.message?.from ?? update.callback_query?.from
    const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id
    const language = from?.language_code
      ? languageFromTelegramCode(from.language_code)
      : ((chatId === undefined ? undefined : this.chatLanguages.get(String(chatId))) ?? 'en')
    return messageLanguage.run(language, () => this.acceptUpdateInLanguage(update, signal))
  }

  // The ordered part of an update: offset, allowlist, then enqueue on the chat's queue. The queued
  // work is returned, not awaited, so the poll loop keeps serving other chats during a slow reply.
  private async acceptUpdateInLanguage(
    update: TelegramUpdate,
    signal?: AbortSignal
  ): Promise<{ done: Promise<void> } | null> {
    if (update.update_id >= this.updateOffset) {
      this.updateOffset = update.update_id + 1
      await this.orca.storage.set(this.key('offset'), this.updateOffset)
    }
    await this.rememberNames(update)

    if (update.callback_query) {
      return this.acceptCallbackQuery(update.callback_query)
    }

    if (update.my_chat_member) {
      await this.handleMembership(update.my_chat_member)
      return null
    }

    const msg = update.message
    if (!msg) return null
    const tgChatId = String(msg.chat.id)
    const inGroup = isGroupChat(msg.chat)
    if (inGroup && !this.config.allowGroups) {
      if (!this.leftGroups.has(tgChatId)) await this.leaveGroup(msg.chat, 'debug')
      return null
    }
    const image = extractIncomingImage(msg)
    const unsupportedImage =
      !image && Boolean(msg.document?.mime_type?.toLowerCase().startsWith('image/'))
    const voice = msg.voice ?? msg.audio ?? null
    // Any other document (spreadsheet, PDF, archive…) goes to the Orca bot as a file.
    const file = !image && !unsupportedImage ? (msg.document ?? null) : null
    // Telegram lets a bot download 20 MB at most; an unknown size is tried.
    const fileTooLarge = (file?.file_size ?? 0) > MAX_TELEGRAM_DOWNLOAD_BYTES
    const group = inGroup ? this.groupMessageText(msg, Boolean(image || voice || file)) : null
    const text = inGroup ? (group?.text ?? null) : (msg.text ?? msg.caption ?? '').trim()
    if (text === null) {
      await this.appendLog(
        'debug',
        'bridge',
        `Ignored message ${msg.message_id} in group ${tgChatId}: not a command, mention or reply to the bot.`
      )
      return null
    }
    if (!text && !image && !unsupportedImage && !voice && !file) return null

    const fromId = msg.from ? String(msg.from.id) : tgChatId
    const allowed = parseAllowedIds(this.config.allowedUserIds)

    if (!isAllowed(this.config.restricted, allowed, fromId, tgChatId)) {
      // In 'all' mode a group's other members talk among themselves; only what they address to the
      // bot earns them the access-denied answer.
      if (group && !group.addressed) {
        await this.appendLog(
          'debug',
          'bridge',
          `Ignored message ${msg.message_id} in group ${tgChatId}: sender ${fromId} is not on the allowlist.`
        )
        return null
      }
      const firstInWindow = await this.recordBlockedUser(
        fromId,
        tgChatId,
        // In a group, also name the group: its ID is what the owner adds to allow the whole group.
        `Blocked unauthorized Telegram user ${fromId} (${formatSenderLabel(msg)})${tgChatId !== fromId ? ` in group ${tgChatId}` : ''}.`
      )
      // The same window as the log line, so a stranger cannot make the bot spam a chat.
      const token = firstInWindow ? await this.readToken() : null
      if (token) {
        await this.safeSendTelegram(
          token,
          msg.chat.id,
          this.i18n.unauthorized(fromId),
          msg.message_id
        )
      }
      return null
    }

    // A group line not addressed to the bot is handled quietly: no typing, no notices in the group.
    const unaddressed = group?.addressed === false
    // Only an allowed chat's language is kept, so strangers never grow the stored map.
    if (msg.from?.language_code) await this.rememberChatLanguage(tgChatId, languageFromTelegramCode(msg.from.language_code))
    // Telegram refused this person's or group's own menu while it knew no chat with them; now it does.
    if (this.unsetScopeIds.has(fromId) || this.unsetScopeIds.has(tgChatId)) this.commandsRegistered = false
    // Each command is checked in handleSlashCommand; anything else is a message and needs 'chat'.
    const isCommand = !image && !unsupportedImage && !voice && !file && text.startsWith('/')
    if (!isCommand && !(await this.mayChat(msg))) return null
    const done = this.enqueueChatWork(tgChatId, async () => {
      try {
        if (unsupportedImage) {
          if (unaddressed) {
            await this.appendLog(
              'info',
              'bridge',
              `Unsupported image ${msg.message_id} in group ${tgChatId} was not addressed to the bot: no notice sent.`
            )
            return
          }
          const token = await this.readToken()
          if (token) {
            await this.safeSendTelegram(
              token,
              msg.chat.id,
              this.i18n.unsupportedImage,
              msg.message_id
            )
          }
          return
        }
        if (file && fileTooLarge) {
          await this.appendLog(
            'info',
            'bridge',
            `Refused ${describeDocument(file)} in message ${msg.message_id}, chat ${tgChatId}: over the 20 MB a Telegram bot can download.`
          )
          if (unaddressed) return
          const token = await this.readToken()
          if (token) {
            await this.safeSendTelegram(token, msg.chat.id, this.i18n.fileTooLarge, msg.message_id)
          }
          return
        }
        if (voice) {
          await this.processVoiceMessage(msg, voice, text, signal, update.update_id, unaddressed)
          return
        }
        await this.processAuthorizedMessage(msg, text, image, file, signal, update.update_id, false, unaddressed)
      } catch (err) {
        // Everything after the Orca bot got the message is answered inside processAuthorizedMessage,
        // so what lands here never reached it and may be sent again.
        const rerun = unsupportedImage || fileTooLarge
          ? undefined
          : voice
          ? (s: AbortSignal | undefined) => this.processVoiceMessage(msg, voice, text, s, update.update_id)
          : (s: AbortSignal | undefined) => this.processAuthorizedMessage(msg, text, image, file, s, update.update_id)
        await this.messageFailed(err, msg, update.update_id, unaddressed, rerun)
      }
    })
    return { done }
  }

  private async acceptCallbackQuery(
    cq: TelegramCallbackQuery
  ): Promise<{ done: Promise<void> } | null> {
    const fromId = String(cq.from.id)
    const tgChatId = cq.message ? String(cq.message.chat.id) : fromId
    // A button on an old group message must not act while groups are off.
    if (cq.message && isGroupChat(cq.message.chat) && !this.config.allowGroups) {
      if (!this.leftGroups.has(tgChatId)) await this.leaveGroup(cq.message.chat, 'debug')
      return null
    }
    const allowed = parseAllowedIds(this.config.allowedUserIds)
    const token = await this.readToken()

    if (!isAllowed(this.config.restricted, allowed, fromId, tgChatId)) {
      await this.recordBlockedUser(fromId, tgChatId, `Blocked unauthorized Telegram callback from ${fromId}.`)
      if (token) {
        await this.safeAnswerCallbackQuery(token, cq.id, this.i18n.callbackUnauthorized, true)
      }
      return null
    }

    if (!token || !cq.message || !cq.data) {
      if (token) {
        await this.safeAnswerCallbackQuery(token, cq.id)
      }
      return null
    }

    // A button acts only when the tapper's role may do what it does; a Run button also needs that
    // automation on the role's list. A refusal answers the tap and does nothing else.
    const role = this.roleOf(fromId, cq.message.chat)
    const data = cq.data
    if (
      !roleAllows(role, permissionForCallback(data, isGroupChat(cq.message.chat))) ||
      (data.startsWith('r:') && !roleMayRun(role, data.slice(2)))
    ) {
      await this.appendLog(
        'info',
        'bridge',
        `Refused button ${callbackDataKind(data)} from ${fromId} in chat ${tgChatId}: role "${role.name}" does not allow it.`
      )
      await this.auditTelegram(cq.from, cq.message.chat, 'refused', 'refused', callbackDataKind(data))
      await this.safeAnswerCallbackQuery(token, cq.id, this.i18n.notAllowedForRole, true)
      return null
    }

    if (data.startsWith('x:') || data.startsWith('d:')) {
      return this.acceptFailureButton(token, cq, cq.message.chat, data)
    }

    const done = this.enqueueChatWork(tgChatId, async () => {
      try {
        await this.processCallbackQuery(token, cq)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await this.appendLog(
          'error',
          'bridge',
          `Failed handling Telegram button in chat ${tgChatId}: ${message}`,
          describeError(err, { tgChatId, callbackId: cq.id, callback: callbackDataKind(cq.data) })
        )
        this.emitState()
        await this.safeAnswerCallbackQuery(token, cq.id, this.i18n.actionFailed(this.redact(message).slice(0, 120)), true)
      }
    })
    return { done }
  }

  // [Try again] (x:) sends the failed message again, for its sender only; [Details] (d:) shows the
  // cause, in a private chat only. Both act at once, not behind a slow answer in the chat's queue,
  // and answer "expired" once the failure is forgotten.
  private async acceptFailureButton(
    token: string,
    cq: TelegramCallbackQuery,
    chat: TelegramChat,
    data: string
  ): Promise<{ done: Promise<void> } | null> {
    const fromId = String(cq.from.id)
    const tgChatId = String(chat.id)
    this.forgetExpiredFailures()
    const failure = this.failedAnswers.get(data.slice(2))
    const retry = data.startsWith('x:')
    // Ids are random, so a failure from another chat, or one with nothing to retry, is a forged tap.
    if (!failure || String(failure.msg.chat.id) !== tgChatId || (retry && !failure.rerun)) {
      await this.safeAnswerCallbackQuery(token, cq.id, this.i18n.retryExpired, true)
      return null
    }
    if (!retry) {
      if (isGroupChat(chat)) {
        await this.appendLog('info', 'bridge', `Refused button d: from ${fromId} in group ${tgChatId}: details are for private chats only.`)
        await this.auditTelegram(cq.from, chat, 'refused', 'refused', 'd:')
        await this.safeAnswerCallbackQuery(token, cq.id, this.i18n.notAllowedForRole, true)
        return null
      }
      await this.safeAnswerCallbackQuery(token, cq.id)
      await this.safeSendTelegram(token, chat.id, failure.detail, failure.msg.message_id)
      await this.auditTelegram(cq.from, chat, 'details', 'done')
      return null
    }
    if (failure.senderId !== fromId) {
      await this.appendLog('info', 'bridge', `Refused button x: from ${fromId} in chat ${tgChatId}: only the sender may retry.`)
      await this.auditTelegram(cq.from, chat, 'refused', 'refused', 'x:')
      await this.safeAnswerCallbackQuery(token, cq.id, this.i18n.retryOnlySender, true)
      return null
    }
    const rerun = failure.rerun!
    // Used up by this tap, so one retry runs at a time; failing again brings new buttons.
    failure.rerun = undefined
    await this.safeAnswerCallbackQuery(token, cq.id)
    await this.appendLog('info', 'bridge', `Retrying message ${failure.msg.message_id} in chat ${tgChatId} for ${fromId}.`)
    await this.auditTelegram(cq.from, chat, 'retry', 'done')
    const done = this.enqueueChatWork(tgChatId, async () => {
      try {
        await rerun(this.pollAbort?.signal)
      } catch (err) {
        await this.messageFailed(err, failure.msg, failure.updateId, false, rerun)
      }
    })
    return { done }
  }

  private forgetExpiredFailures(): void {
    const now = Date.now()
    for (const [id, failure] of this.failedAnswers) {
      if (failure.expiresAt <= now) this.failedAnswers.delete(id)
    }
  }

  // A failure that escaped a message's handling: logged, then answered unless the group line was
  // not addressed to the bot.
  private async messageFailed(
    err: unknown,
    msg: TelegramMessage,
    updateId: number,
    unaddressed: boolean,
    rerun: FailedAnswer['rerun']
  ): Promise<void> {
    const tgChatId = String(msg.chat.id)
    const message = err instanceof Error ? err.message : String(err)
    await this.appendLog(
      'error',
      'bridge',
      `Failed handling Telegram message in chat ${tgChatId}: ${message}`,
      describeError(err, { tgChatId, updateId, messageId: msg.message_id })
    )
    this.emitState()
    if (unaddressed) return
    const token = await this.readToken()
    if (token) await this.sendFailureLine(token, msg, updateId, err, rerun)
  }

  // One plain line by kind of failure; its technical text is only in the Logs and behind [Details]
  // (a private chat whose sender's role has errorDetails). [Try again] only with `rerun`.
  private async sendFailureLine(
    token: string,
    msg: TelegramMessage,
    updateId: number,
    err: unknown,
    rerun: FailedAnswer['rerun']
  ): Promise<void> {
    const i18n = this.i18n
    const line =
      err instanceof DispatchTimeoutError
        ? i18n.errorTimeout
        : err instanceof OrcaCliError
        ? i18n.errorOrcaUnreachable
        : i18n.errorGeneric
    const senderId = msg.from ? String(msg.from.id) : String(msg.chat.id)
    const details = !isGroupChat(msg.chat) && roleAllows(this.roleOf(senderId, msg.chat), 'errorDetails')
    const buttons: TelegramInlineKeyboardButton[] = []
    if (rerun || details) {
      this.forgetExpiredFailures()
      const id = randomBytes(6).toString('base64url')
      const message = err instanceof Error ? err.message : String(err)
      this.failedAnswers.set(id, {
        msg,
        senderId,
        updateId,
        rerun,
        detail: truncateText(this.redact(message), MAX_DETAIL_CHARS),
        expiresAt: Date.now() + (this.deps.failedAnswerTtlMs ?? FAILED_ANSWER_TTL_MS)
      })
      if (rerun) buttons.push({ text: i18n.retryButton, callback_data: `x:${id}` })
      if (details) buttons.push({ text: i18n.detailsButton, callback_data: `d:${id}` })
    }
    await this.safeSendTelegram(
      token,
      msg.chat.id,
      line,
      msg.message_id,
      false,
      buttons.length > 0 ? { inline_keyboard: [buttons] } : undefined
    )
  }

  // The role that applies to this sender in this chat (rules in src/roles.ts).
  private roleOf(senderId: string, chat: TelegramChat): BridgeRole {
    return resolveRole(this.config.roles, this.config.roleAssignments, {
      senderId,
      chatId: String(chat.id),
      isGroup: isGroupChat(chat),
      openToEveryone: !this.config.restricted
    })
  }

  // One plain line for what the sender's role does not allow; the log names the role and what was
  // refused, the audit the command or `chat`, never the message text.
  private async refuseForRole(
    token: string,
    msg: TelegramMessage,
    role: BridgeRole,
    what: string,
    target: string
  ): Promise<void> {
    const fromId = msg.from ? String(msg.from.id) : String(msg.chat.id)
    await this.appendLog(
      'info',
      'bridge',
      `Refused ${what} from ${fromId} in chat ${msg.chat.id}: role "${role.name}" does not allow it.`
    )
    await this.auditTelegram(msg.from, msg.chat, 'refused', 'refused', target)
    await this.safeSendTelegram(token, msg.chat.id, this.i18n.notAllowedForRole, msg.message_id)
  }

  // Messages need the sender's role to allow 'chat'. Without it a private chat gets the refusal
  // line; a group is left alone, as its other members may be talking among themselves.
  private async mayChat(msg: TelegramMessage): Promise<boolean> {
    const role = this.roleOf(msg.from ? String(msg.from.id) : String(msg.chat.id), msg.chat)
    if (roleAllows(role, 'chat')) return true
    if (isGroupChat(msg.chat)) {
      await this.appendLog(
        'debug',
        'bridge',
        `Ignored message ${msg.message_id} in group ${msg.chat.id}: role "${role.name}" may not chat.`
      )
      return false
    }
    const token = await this.readToken()
    if (token) await this.refuseForRole(token, msg, role, 'a message', 'chat')
    return false
  }

  // One audit entry for what a Telegram user did here or was refused, with their role in this chat.
  // A done change to a group's shared chat, sync or automations also tells the group, when the
  // bridge's groupAuditNotice is on.
  private async auditTelegram(
    from: TelegramUser | undefined,
    chat: TelegramChat,
    action: AuditAction,
    result: AuditEntry['result'],
    target?: string
  ): Promise<void> {
    const userId = from ? String(from.id) : String(chat.id)
    const who = formatSenderLabel(from ? { from, chat } : { chat })
    await this.manager.recordAudit({
      bridgeId: this.id,
      source: 'telegram',
      userId,
      userLabel: who,
      chatId: String(chat.id),
      roleName: this.roleOf(userId, chat).name,
      action,
      ...(target ? { target } : {}),
      result
    })
    if (result === 'done' && this.config.groupAuditNotice && isGroupChat(chat)) {
      await this.sendGroupNotice(chat, action, who, target)
    }
  }

  // One plain line in the language this bridge answers in; only for actions that change what the
  // whole group shares.
  private async sendGroupNotice(chat: TelegramChat, action: AuditAction, who: string, target?: string): Promise<void> {
    const notices = this.i18n.groupNotice
    let line: string
    switch (action) {
      case 'new':
      case 'home':
      case 'bind':
      case 'rename':
        line = notices[action](who)
        break
      case 'sync':
        line = notices.sync(who, target === 'on')
        break
      case 'run':
        line = notices.run(who, target ?? '')
        break
      default:
        return
    }
    const token = await this.readToken()
    if (token) await this.safeSendTelegram(token, chat.id, line)
  }

  // Panel entries for what a save changed: access, roles and the token, never the token itself.
  private async auditPanelSave(prev: BridgeConfig, prevToken: string | null): Promise<void> {
    const access = accessChange(prev, this.config)
    if (access) await this.auditPanel('access', access)
    const roles = roleChanges(prev, this.config)
    if (roles) await this.auditPanel('roles', roles)
    if (prevToken !== this.cachedToken) await this.auditPanel('token', this.cachedToken ? 'changed' : 'cleared')
  }

  private auditPanel(action: AuditAction, target: string): Promise<void> {
    return this.manager.recordAudit({ bridgeId: this.id, source: 'panel', action, target, result: 'done' })
  }

  // An automation's name for the audit and the group line; its id when Orca cannot list them.
  private async automationName(id: string): Promise<string> {
    try {
      return (await this.deps.orcaCli.listAutomations()).find((a) => a.id === id)?.name || id
    } catch (err) {
      await this.appendLog('debug', 'orca-cli', `Reading the name of automation ${id} failed`, describeError(err))
      return id
    }
  }

  private enqueueChatWork(tgChatId: string, work: () => Promise<void>): Promise<void> {
    const prev = this.chatQueues.get(tgChatId) ?? Promise.resolve()
    const next = prev
      .then(work)
      // The work runs detached from the poll loop, so a rejection must end here.
      .catch(async (err) => {
        const message = err instanceof Error ? err.message : String(err)
        await this.appendLog(
          'error',
          'bridge',
          `Telegram chat ${tgChatId} work failed: ${message}`,
          describeError(err, { tgChatId })
        )
        this.emitState()
      })
      .finally(() => {
        if (this.chatQueues.get(tgChatId) === next) {
          this.chatQueues.delete(tgChatId)
        }
      })
    this.chatQueues.set(tgChatId, next)
    return next
  }

  // Any stranger can flood the bot; log and post each blocked id at most once a minute per chat.
  // Returns false while that sender and chat are still inside the window.
  private async recordBlockedUser(fromId: string, tgChatId: string, logMessage: string): Promise<boolean> {
    const now = Date.now()
    for (const [id, at] of this.blockedLoggedAt) {
      if (now - at >= BLOCK_LOG_INTERVAL_MS) this.blockedLoggedAt.delete(id)
    }
    // Keyed by chat too: each group the sender writes from is logged, as its ID is what the owner allows.
    const key = `${fromId}:${tgChatId}`
    if (this.blockedLoggedAt.has(key)) return false
    this.blockedLoggedAt.set(key, now)
    this.lastBlockedUserId = fromId
    await this.orca.storage.set(this.key('lastBlocked'), fromId)
    await this.appendLog('warn', 'bridge', logMessage)
    this.emitState()
    return true
  }

  // Telegram reports the bot's own membership changes. With groups off, the bot leaves any group it
  // is added to.
  private async handleMembership(change: TelegramChatMemberUpdated): Promise<void> {
    const status = change.new_chat_member.status
    if (this.config.allowGroups || !isGroupChat(change.chat)) return
    if (status !== 'member' && status !== 'administrator') return
    await this.leaveGroup(change.chat, 'info')
  }

  private async leaveGroup(chat: TelegramChat, level: 'info' | 'debug'): Promise<void> {
    const tgChatId = String(chat.id)
    this.leftGroups.add(tgChatId)
    const token = await this.readToken()
    if (!token) return
    try {
      await this.deps.telegram.leaveChat(token, chat.id, { proxyUrl: this.config.proxyUrl, timeoutMs: 10_000 })
      await this.appendLog(
        level,
        'bridge',
        `Left group ${tgChatId}${chat.title ? ` (${chat.title})` : ''}: groups are off for this bridge`
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await this.appendLog('warn', 'telegram', `Leaving group ${tgChatId} failed: ${message}`, describeError(err, { tgChatId }))
    }
    if (level === 'info') this.emitState()
  }

  // In groups the bot answers commands for it, mentions of @botUsername and replies to its own
  // messages. In 'all' mode it also reads every other line, but only while the allowlist is
  // restricted: in an open bridge every stranger's line would start an Orca run. Returns the text to
  // process (mention removed) and whether it was addressed to the bot, or null to ignore it.
  private groupMessageText(msg: TelegramMessage, hasMedia: boolean): { text: string; addressed: boolean } | null {
    const username = this.botUsername
    if (!username) return null
    const raw = (msg.text ?? msg.caption ?? '').trim()
    if (!hasMedia && raw.startsWith('/')) {
      const rawCmd = raw.split(/\s+/)[0]
      const at = rawCmd.indexOf('@')
      // '/cmd@other_bot' is for another bot in the same group.
      return at === -1 || rawCmd.slice(at + 1).toLowerCase() === username.toLowerCase()
        ? { text: raw, addressed: true }
        : null
    }
    const { mentioned, text } = stripBotMention(msg, username)
    const replyToBot =
      this.botUserId !== null && msg.reply_to_message?.from?.id === this.botUserId
    if (mentioned || replyToBot) return { text, addressed: true }
    const readsAll = this.config.groupMode === 'all' && this.config.restricted
    return readsAll ? { text, addressed: false } : null
  }

  private async processAuthorizedMessage(
    msg: TelegramMessage,
    text: string,
    image: IncomingTelegramImage | null,
    // Any other document, passed on as a file.
    file: TelegramDocument | null,
    signal: AbortSignal | undefined,
    updateId: number,
    // A transcript is sent as is, even when it starts with '/'.
    fromVoice = false,
    // A group message not addressed to the bot (groupMode 'all'): quiet, and the reply policy applies.
    unaddressed = false,
    // Images and files saved by an earlier try of this message, so [Try again] does not download them again.
    savedImagePaths: string[] = [],
    savedFiles: { path: string; name: string }[] = []
  ): Promise<void> {
    const token = await this.readToken()
    if (!token) return

    const tgChatId = String(msg.chat.id)
    const fromId = msg.from ? String(msg.from.id) : tgChatId
    const senderLabel = formatSenderLabel(msg)

    if (!image && !file && !fromVoice && text.startsWith('/')) {
      const handled = await this.handleSlashCommand(token, msg, text)
      if (handled) return
    }

    const binding = await this.resolveBindingBot(await this.getOrCreateBinding(tgChatId, fromId))
    if (!binding.botName) {
      await this.appendLog('error', 'dispatch', 'No Orca bots found to route incoming Telegram message.')
      this.emitState()
      if (unaddressed) return
      await this.safeSendTelegram(
        token,
        msg.chat.id,
        this.i18n.noBotsAvailable,
        msg.message_id
      )
      return
    }
    // Only the length of what the user wrote is logged, never the text; a file only by extension and size.
    const content = [
      text ? `${fromVoice ? 'transcript' : 'text'} ${text.length} chars` : '',
      image ? 'image' : '',
      file ? describeDocument(file) : ''
    ].filter(Boolean).join(' + ')
    await this.appendLog('info', 'dispatch', `[TG ${senderLabel} -> ${binding.botName}] ${content}`)
    this.emitState()

    this.activeTelegramTgChats.add(tgChatId)
    if (binding.orcaChatId) {
      this.activeTelegramOrcaChats.add(binding.orcaChatId)
    }

    let boundOrcaChatId = binding.orcaChatId
    const stats: DispatchStats = { startedAt: Date.now(), polls: 0 }
    const imagePaths = [...savedImagePaths]
    const files = [...savedFiles]
    // Never for an unaddressed group line: those stay quiet.
    const working = unaddressed ? null : this.startWorkingLine(token, msg)
    try {
      if (image && imagePaths.length === 0) {
        if (!unaddressed) await this.sendTypingAction(token, msg.chat.id)
        const savedPath = await this.downloadTelegramImage(token, image, msg.message_id, signal)
        imagePaths.push(savedPath)
      }
      if (file && files.length === 0) {
        if (!unaddressed) await this.sendTypingAction(token, msg.chat.id)
        files.push(await this.downloadTelegramDocument(token, file, msg.message_id, signal))
      }

      const result = await this.dispatchTraced(stats, {
        botName: binding.botName,
        boundChatId: binding.orcaChatId,
        tgChatId,
        senderLabel,
        userText: text,
        imagePaths,
        files,
        unaddressedGroupReply: unaddressed ? this.config.groupReply : undefined,
        rolePrompt: this.roleOf(fromId, msg.chat).prompt,
        answerLanguage:
          this.config.replyLanguage === 'auto' ? LANGUAGE_NAMES[messageLanguage.getStore() ?? 'en'] : undefined,
        timeoutMs: this.config.replyTimeoutSec * 1000,
        pollIntervalMs: this.deps.pollIntervalMs,
        signal,
        onChatBound: async (chatId, title) => {
          boundOrcaChatId = chatId
          this.activeTelegramOrcaChats.add(chatId)
          await this.upsertBinding({
            tgChatId,
            botId: binding.botId,
            botName: binding.botName,
            orcaChatId: chatId,
            title,
            updatedAt: Date.now()
          })
          this.emitState()
        },
        onWorkingTick: unaddressed ? undefined : () => this.sendTypingAction(token, msg.chat.id)
      })

      // Gone before the answer, so the phone notifies for the answer itself.
      await working?.stop()
      boundOrcaChatId = result.chatId
      this.activeTelegramOrcaChats.add(result.chatId)
      await this.upsertBinding({
        tgChatId,
        botId: binding.botId,
        botName: binding.botName,
        orcaChatId: result.chatId,
        title: result.title || binding.title,
        updatedAt: Date.now()
      })

      // Orca's NO_REPLY: the bot has nothing to report, so Telegram gets nothing either.
      const replyWords = withoutQuietMarker(result.replyText)
      // 'mentioned' is enforced here too: the bot may answer an unaddressed line anyway.
      const withheld = unaddressed && this.config.groupReply === 'mentioned' && replyWords !== null
      const delivery =
        replyWords === null || withheld
          ? { messageCount: 0, imageCount: 0, attachmentCount: 0 }
          : await this.sendFormattedReplyToTelegram(
              token,
              msg.chat.id,
              result.shortened ? `${replyWords}\n\n${this.i18n.shortenedNote}` : replyWords,
              msg.message_id
            )

      const existingCursor = this.syncCursors[result.chatId]
      this.syncCursors[result.chatId] = {
        tailHashes: result.tailHashes,
        ...(existingCursor?.lastActivityAt !== undefined
          ? { lastActivityAt: existingCursor.lastActivityAt }
          : {}),
        pendingWorking: false
      }
      await this.saveSyncCursors()

      await this.appendLog(
        'info',
        'dispatch',
        replyWords === null
          ? `[${binding.botName} -> TG ${tgChatId}] Answered NO_REPLY: nothing sent.`
          : withheld
          ? `[${binding.botName} -> TG ${tgChatId}] Unaddressed group message in 'mentioned' mode: reply of ${replyWords.length} chars not sent.`
          : `[${binding.botName} -> TG ${tgChatId}] Sent ${delivery.messageCount} message(s)${
              delivery.imageCount > 0 ? ` + ${delivery.imageCount} table image(s)` : ''
            }${delivery.attachmentCount > 0 ? ` + ${delivery.attachmentCount} attachment(s)` : ''}.`
      )
      await this.nameOrcaChat(msg, tgChatId, binding, result.chatId, result.title)
      this.emitState()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await this.appendLog(
        'error',
        'dispatch',
        `Failed handling message for ${binding.botName}: ${message}`,
        describeError(err, {
          tgChatId,
          updateId,
          messageId: msg.message_id,
          bot: binding.botName,
          orcaChatId: boundOrcaChatId,
          elapsedMs: Date.now() - stats.startedAt,
          polls: stats.polls
        })
      )
      this.emitState()
      if (!unaddressed) {
        await working?.stop()
        // Only a message that never reached the Orca bot is offered again: once it has it, its turn
        // may still be running (always so after a timeout).
        await this.sendFailureLine(
          token,
          msg,
          updateId,
          err,
          stats.sent
            ? undefined
            : (s) => this.processAuthorizedMessage(msg, text, image, file, s, updateId, fromVoice, false, imagePaths, files)
        )
      }
    } finally {
      this.activeTelegramTgChats.delete(tgChatId)
      if (boundOrcaChatId) {
        this.activeTelegramOrcaChats.delete(boundOrcaChatId)
      }
    }
  }

  // A voice note or audio file is transcribed, then handled like the text the sender would have
  // typed. Voice off, no API key or a failed transcription: the sender is told (only logged for an
  // unaddressed group message); nothing is dispatched.
  private async processVoiceMessage(
    msg: TelegramMessage,
    voice: TelegramAudio,
    caption: string,
    signal: AbortSignal | undefined,
    updateId: number,
    unaddressed = false
  ): Promise<void> {
    const token = await this.readToken()
    if (!token) return
    const tgChatId = String(msg.chat.id)
    const apiKey = this.config.voiceEnabled ? await this.readVoiceKey() : null
    if (!apiKey) {
      await this.appendLog(
        'debug',
        'bridge',
        `Voice message ${msg.message_id} in chat ${tgChatId} not transcribed: voice messages are ${
          this.config.voiceEnabled ? 'on but have no API key' : 'off'
        }.`
      )
      if (!unaddressed) await this.safeSendTelegram(token, msg.chat.id, this.i18n.voiceDisabled, msg.message_id)
      return
    }

    const provider = this.config.voiceProvider
    const model = this.config.voiceModel || DEFAULT_VOICE_MODELS[provider]
    const startedAt = Date.now()
    let bytes = voice.file_size ?? 0
    let transcript = ''
    let failure: unknown = null
    // English for the log, localized for the sender.
    let logReason: string | null = null
    let replyReason = ''
    // Telegram lets a bot download 20 MB at most, below the providers' 25 MB.
    if (bytes > Math.min(MAX_TRANSCRIBE_BYTES, MAX_TELEGRAM_DOWNLOAD_BYTES)) {
      logReason = 'the file is over 20 MB'
      replyReason = this.i18n.voiceTooLarge
    } else {
      try {
        if (!unaddressed) await this.sendTypingAction(token, msg.chat.id)
        const fileMeta = await this.deps.telegram.getFile(token, voice.file_id, {
          proxyUrl: this.config.proxyUrl,
          timeoutMs: 15_000,
          signal
        })
        if (!fileMeta.file_path) {
          throw new Error('Telegram did not return a downloadable file_path for this audio.')
        }
        const audio = await this.deps.telegram.downloadFile(token, fileMeta.file_path, {
          proxyUrl: this.config.proxyUrl,
          timeoutMs: 30_000,
          signal
        })
        bytes = audio.length
        // The providers tell the format by the file name's extension.
        const fileName = msg.voice
          ? 'voice.ogg'
          : voice.file_name || `audio${path.extname(fileMeta.file_path) || '.ogg'}`
        transcript = (
          await this.transcribe({
            provider,
            model: this.config.voiceModel,
            apiKey,
            audio,
            fileName,
            mimeType: voice.mime_type || (msg.voice ? 'audio/ogg' : 'application/octet-stream'),
            proxyUrl: this.config.proxyUrl,
            timeoutMs: TRANSCRIBE_TIMEOUT_MS,
            signal
          })
        ).trim()
        if (!transcript) {
          logReason = 'the transcript is empty'
          replyReason = this.i18n.voiceEmpty
        }
      } catch (err) {
        failure = err
        logReason = err instanceof Error ? err.message : String(err)
        replyReason = truncateText(this.redact(logReason), 200)
      }
    }

    if (logReason !== null) {
      await this.appendLog(
        'warn',
        'bridge',
        `Voice message ${msg.message_id} in chat ${tgChatId} not transcribed: ${logReason}`,
        describeError(failure ?? logReason, {
          bridge: this.id,
          tgChatId,
          updateId,
          messageId: msg.message_id,
          durationSec: voice.duration,
          bytes,
          provider,
          model,
          elapsedMs: Date.now() - startedAt
        })
      )
      this.emitState()
      if (!unaddressed) {
        await this.safeSendTelegram(token, msg.chat.id, this.i18n.voiceFailed(replyReason), msg.message_id)
      }
      return
    }

    // Only sizes and times are logged, never the transcript.
    await this.appendLog(
      'info',
      'bridge',
      `Transcribed voice message ${msg.message_id} in chat ${tgChatId}: ${voice.duration} s, ${bytes} bytes, ${provider} ${model}, ${Date.now() - startedAt} ms.`
    )
    const text = `${caption ? `${caption}\n` : ''}${VOICE_PREFIX} ${transcript}`
    await this.processAuthorizedMessage(msg, text, null, null, signal, updateId, true, unaddressed)
  }

  private async sendTypingAction(token: string, chatId: number): Promise<void> {
    try {
      await this.deps.telegram.sendChatAction(
        token,
        { chatId, action: 'typing' },
        { proxyUrl: this.config.proxyUrl, timeoutMs: 8000 }
      )
    } catch (err) {
      // Non-fatal: the reply still goes out without a typing indicator.
      await this.appendLog(
        'debug',
        'telegram',
        `Typing indicator failed for chat ${chatId}`,
        describeError(err, { tgChatId: chatId })
      )
    }
  }

  // After WORKING_LINE_AFTER_MS without an answer, replies "⏳ Working… 20s" to the message and edits
  // the time at most every WORKING_LINE_EVERY_MS. stop() ends it and deletes the line; it never
  // throws and may be called again.
  private startWorkingLine(token: string, msg: TelegramMessage): { stop: () => Promise<void> } {
    // Taken now, so every edit speaks the language of the message it answers.
    const i18n = this.i18n
    const startedAt = Date.now()
    const options = { proxyUrl: this.config.proxyUrl, timeoutMs: 10_000 }
    let messageId: number | null = null
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    // The send or edit in flight; stop() waits for it, so a line sent late is still deleted.
    let pending: Promise<void> = Promise.resolve()
    const tick = () => {
      pending = (async () => {
        if (stopped) return
        const text = `⏳ ${i18n.workingLine(Date.now() - startedAt)}`
        try {
          if (messageId === null) {
            const sent = await this.deps.telegram.sendMessage(
              token,
              { chatId: msg.chat.id, text, replyToMessageId: msg.message_id },
              options
            )
            messageId = sent.message_id
          } else {
            await this.deps.telegram.editMessageText(token, { chatId: msg.chat.id, messageId, text }, options)
          }
        } catch (err) {
          // Non-fatal: the answer still comes; the next tick tries again.
          await this.appendLog(
            'debug',
            'telegram',
            `Working line in chat ${msg.chat.id} failed`,
            describeError(err, { tgChatId: msg.chat.id, messageId: messageId ?? undefined })
          )
        }
        if (!stopped) timer = setTimeout(tick, this.deps.workingLineEveryMs ?? WORKING_LINE_EVERY_MS)
      })()
    }
    timer = setTimeout(tick, this.deps.workingLineAfterMs ?? WORKING_LINE_AFTER_MS)
    return {
      stop: async () => {
        stopped = true
        clearTimeout(timer)
        await pending
        if (messageId === null) return
        const id = messageId
        messageId = null
        await this.removeWorkingLine(token, msg.chat.id, id)
      }
    }
  }

  // Deletes a working line; when Telegram refuses (e.g. no right to delete in a group), it is edited
  // to "✓" so it no longer looks busy, and the chat is warned about once.
  private async removeWorkingLine(token: string, chatId: number, messageId: number): Promise<void> {
    const options = { proxyUrl: this.config.proxyUrl, timeoutMs: 10_000 }
    try {
      await this.deps.telegram.deleteMessage(token, chatId, messageId, options)
      return
    } catch (err) {
      const tgChatId = String(chatId)
      const level = this.workingLineWarned.has(tgChatId) ? 'debug' : 'warn'
      this.workingLineWarned.add(tgChatId)
      await this.appendLog(
        level,
        'telegram',
        `Deleting the working line in chat ${tgChatId} failed; marking it done instead.`,
        describeError(err, { tgChatId, messageId })
      )
    }
    try {
      await this.deps.telegram.editMessageText(token, { chatId, messageId, text: '✓' }, options)
    } catch (err) {
      await this.appendLog(
        'debug',
        'telegram',
        `Marking the working line in chat ${chatId} done failed`,
        describeError(err, { tgChatId: chatId, messageId })
      )
    }
  }

  // dispatchToOrcaBotAndWait with debug start/finish entries; `stats` counts its session reads and
  // notes when the Orca bot got the message.
  private async dispatchTraced(stats: DispatchStats, params: DispatchParams): Promise<DispatchResult> {
    const cli = this.deps.orcaCli
    const runner: OrcaCliRunner = {
      ...cli,
      readSession: async (sessionId, limit) => {
        stats.polls++
        const session = await cli.readSession(sessionId, limit)
        stats.lastState = session.state
        return session
      },
      sendToBot: async (sendParams) => {
        try {
          await cli.sendToBot(sendParams)
        } catch (err) {
          // Any failure once the CLI is running (timeout, exit, Orca's own error, garbage) may come
          // after the message was delivered: the CLI keeps no proof either way. Counting it as sent
          // keeps [Try again] from running a request twice; only a CLI that never started is sure
          // not to have delivered it.
          if (!(err instanceof OrcaCliError && err.kind === 'spawn')) {
            stats.sent = true
          }
          throw err
        }
        stats.sent = true
      }
    }
    await this.appendLog(
      'debug',
      'dispatch',
      `Dispatch start: bot ${params.botName}, tg chat ${params.tgChatId}, ${
        params.boundChatId ? `bound Orca chat ${params.boundChatId}` : 'new Orca chat'
      }, body ${params.userText.length} chars, ${params.imagePaths?.length ?? 0} image(s), ${params.files?.length ?? 0} file(s)`
    )
    const result = await dispatchToOrcaBotAndWait(runner, params)
    await this.appendLog(
      'debug',
      'dispatch',
      `Dispatch finished in ${Date.now() - stats.startedAt} ms: Orca chat ${result.chatId}, ${
        stats.polls
      } poll(s), state ${stats.lastState ?? 'unknown'}, reply ${result.replyText.length} chars`
    )
    return result
  }

  private async downloadTelegramImage(
    token: string,
    image: IncomingTelegramImage,
    messageId: number,
    signal: AbortSignal | undefined
  ): Promise<string> {
    const fileMeta = await this.deps.telegram.getFile(token, image.fileId, {
      proxyUrl: this.config.proxyUrl,
      timeoutMs: 15_000,
      signal
    })
    if (!fileMeta.file_path) {
      throw new Error('Telegram did not return a downloadable file_path for this image.')
    }
    const bytes = await this.deps.telegram.downloadFile(token, fileMeta.file_path, {
      proxyUrl: this.config.proxyUrl,
      timeoutMs: 30_000,
      signal
    })

    const dir = this.deps.downloadDir ?? path.join(os.tmpdir(), 'orca-telegram-bridge', 'images')
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    await this.cleanupOldDownloads(dir)

    const ext = resolveSafeImageExt(fileMeta.file_path, image.ext)
    const filename = `tg-${Date.now()}-${messageId}-${Math.random().toString(36).slice(2, 6)}${ext}`
    const targetPath = path.join(dir, filename)
    await fs.writeFile(targetPath, bytes)
    return targetPath
  }

  // Saved under the sanitized name so the Orca bot's tools see the right extension; its own folder,
  // apart from the images.
  private async downloadTelegramDocument(
    token: string,
    doc: TelegramDocument,
    messageId: number,
    signal: AbortSignal | undefined
  ): Promise<{ path: string; name: string }> {
    const fileMeta = await this.deps.telegram.getFile(token, doc.file_id, {
      proxyUrl: this.config.proxyUrl,
      timeoutMs: 15_000,
      signal
    })
    if (!fileMeta.file_path) {
      throw new Error('Telegram did not return a downloadable file_path for this file.')
    }
    const bytes = await this.deps.telegram.downloadFile(token, fileMeta.file_path, {
      proxyUrl: this.config.proxyUrl,
      timeoutMs: 30_000,
      signal
    })

    const dir = path.join(this.deps.downloadDir ?? os.tmpdir(), 'orca-telegram-bridge', 'files')
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    await this.cleanupOldDownloads(dir)

    const safeName = safeDocumentName(doc.file_name, fileMeta.file_path)
    const filename = `tg-${Date.now()}-${messageId}-${Math.random().toString(36).slice(2, 6)}-${safeName}`
    const targetPath = path.join(dir, filename)
    await fs.writeFile(targetPath, bytes)
    return { path: targetPath, name: doc.file_name || safeName }
  }

  private async cleanupOldDownloads(dir: string): Promise<void> {
    try {
      const cutoffMs = Date.now() - 24 * 60 * 60 * 1000
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile()) continue
        const full = path.join(dir, entry.name)
        try {
          const stat = await fs.stat(full)
          if (stat.mtimeMs < cutoffMs) {
            await fs.unlink(full)
          }
        } catch (err) {
          // Best-effort cleanup.
          await this.appendLog('debug', 'bridge', 'Removing an old downloaded file failed', describeError(err))
        }
      }
    } catch (err) {
      // Best-effort cleanup.
      await this.appendLog('debug', 'bridge', 'Listing downloaded files for cleanup failed', describeError(err))
    }
  }

  // Text first, then table images, then the files and URLs the reply attached with `![caption](target)`.
  private async sendFormattedReplyToTelegram(
    token: string,
    chatId: number | string,
    rawMarkdown: string,
    replyToMessageId?: number
  ): Promise<{ messageCount: number; imageCount: number; attachmentCount: number }> {
    const renderTable = this.deps.renderTable ?? renderTableToPng
    const i18n = this.i18n
    const { text, attachments } = extractAttachments(rawMarkdown)
    const { textWithMarkers, tables } = extractTablesFromMarkdown(text, i18n.tableMarker)
    const renderedImages: { index: number; png: Buffer }[] = []

    for (let i = 0; i < tables.length; i++) {
      const png = await renderTable(tables[i])
      if (png) {
        renderedImages.push({ index: i + 1, png })
      }
    }

    // Only swap tables for markers if all tables rendered as PNGs; otherwise keep raw markdown fallback.
    const finalText =
      renderedImages.length === tables.length && renderedImages.length > 0
        ? textWithMarkers
        : text

    // A reply that is only attachments sends no "(empty reply)" text.
    const chunks = attachments.length > 0 && !finalText.trim() ? [] : splitTelegramMessage(finalText, 3500)
    for (let i = 0; i < chunks.length; i++) {
      await this.safeSendTelegram(
        token,
        chatId,
        chunks[i],
        i === 0 ? replyToMessageId : undefined,
        true
      )
    }

    let imageCount = 0
    if (renderedImages.length === tables.length && renderedImages.length > 0) {
      for (const img of renderedImages) {
        await this.safeSendTelegramPhoto(
          token,
          chatId,
          img.png,
          `table-${img.index}.png`,
          tables.length > 1 ? i18n.tableCaption(img.index) : undefined
        )
        imageCount++
      }
    }

    // Without text, the first message that goes out answers the user's message.
    let replyTo = chunks.length === 0 ? replyToMessageId : undefined
    let attachmentCount = 0
    const failures: string[] = []
    // An open bridge answers anyone, so files from this computer go out only once it is restricted.
    const localFilesAllowed = this.config.restricted
    const heldBack: string[] = []
    for (const attachment of attachments) {
      if (attachment.target.kind === 'file' && !localFilesAllowed) {
        heldBack.push(attachment.target.path)
        continue
      }
      const failure = await this.sendOutboundAttachment(token, chatId, attachment, replyTo)
      if (failure) {
        failures.push(failure)
      } else {
        attachmentCount++
        replyTo = undefined
      }
    }
    if (heldBack.length > 0) {
      failures.push(i18n.attachmentNeedsAllowlist)
      await this.appendLog(
        'warn',
        'telegram',
        `${heldBack.length} local file attachment(s) for chat ${chatId} not sent: the allowlist is empty, so the bridge is open to everyone`,
        heldBack.map((p) => `path=${p}`).join('\n')
      )
    }
    if (failures.length > 0) {
      await this.safeSendTelegramChunks(token, chatId, failures.join('\n'), replyTo)
    }

    return {
      messageCount: chunks.length + (failures.length > 0 ? 1 : 0),
      imageCount,
      attachmentCount
    }
  }

  // Sends one attachment from a bot reply. Returns the line telling the Telegram user why it was
  // not sent (file name only; logs carry the full path), or null once Telegram took it.
  private async sendOutboundAttachment(
    token: string,
    chatId: number | string,
    attachment: OutboundAttachment,
    replyToMessageId: number | undefined
  ): Promise<string | null> {
    const i18n = this.i18n
    const { target, name } = attachment
    const caption = attachment.caption || undefined
    let upload: {
      method: 'photo' | 'document'
      file: Buffer | string
      filename?: string
      contentType?: string
    }
    // Logged in place of the file: the path, or the URL without its query (it may hold a key).
    let source: string
    if (target.kind === 'url') {
      const url = new URL(target.url)
      source = `${url.origin}${url.pathname}`
      upload = { method: target.image ? 'photo' : 'document', file: target.url }
    } else {
      source = target.path
      const loaded = await loadLocalAttachment(target.path)
      if (!loaded.ok) {
        const reasons: Record<AttachmentProblem, string> = {
          missing: i18n.attachmentMissing,
          unreadable: i18n.attachmentUnreadable,
          too_large: i18n.attachmentTooLarge,
          not_allowed: i18n.attachmentNotAllowed,
          not_image: i18n.attachmentNotImage
        }
        await this.appendLog(
          'warn',
          'telegram',
          `Attachment ${name} for chat ${chatId} not sent: ${loaded.problem}`,
          [`path=${target.path}`, ...(loaded.realPath ? [`realPath=${loaded.realPath}`] : [])].join('\n')
        )
        return i18n.attachmentFailed(name, reasons[loaded.problem])
      }
      const { file } = loaded
      upload = { method: file.method, file: file.data, filename: file.filename, contentType: file.contentType }
    }

    const options = {
      proxyUrl: this.config.proxyUrl,
      timeoutMs: typeof upload.file === 'string' ? 60_000 : 120_000
    }
    const sendDocument = () =>
      this.deps.telegram.sendDocument(
        token,
        {
          chatId,
          document: upload.file,
          filename: upload.filename,
          contentType: upload.contentType,
          caption,
          replyToMessageId
        },
        options
      )
    try {
      if (upload.method === 'document') {
        await sendDocument()
        return null
      }
      try {
        await this.deps.telegram.sendPhoto(
          token,
          { chatId, photo: upload.file, filename: upload.filename, contentType: upload.contentType, caption, replyToMessageId },
          options
        )
      } catch (err) {
        // Telegram refuses photos it cannot process (dimensions, size, URL content); as a
        // document the same file goes through unchanged.
        if (!(err instanceof TelegramApiError) || (err.statusCode !== 400 && err.statusCode !== 413)) throw err
        await this.appendLog(
          'debug',
          'telegram',
          `Telegram refused ${name} as a photo; sending it as a document`,
          describeError(err, { tgChatId: chatId, path: source })
        )
        await sendDocument()
      }
      return null
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await this.appendLog(
        'warn',
        'telegram',
        `Sending attachment ${name} to chat ${chatId} failed: ${message}`,
        describeError(err, {
          tgChatId: chatId,
          path: source,
          bytes: typeof upload.file === 'string' ? undefined : upload.file.length
        })
      )
      return i18n.attachmentFailed(name, i18n.attachmentRejected)
    }
  }

  private async handleSlashCommand(
    token: string,
    msg: TelegramMessage,
    text: string
  ): Promise<boolean> {
    const [rawCmd, ...rest] = text.split(/\s+/)
    const cmd = rawCmd.split('@')[0].toLowerCase()
    const arg = rest.join(' ').trim()
    const tgChatId = String(msg.chat.id)
    const fromId = msg.from ? String(msg.from.id) : tgChatId
    const isGroup = isGroupChat(msg.chat)
    const role = this.roleOf(fromId, msg.chat)
    // Checked before anything else, so a refused command has no side effect (not even a binding).
    // Unknown commands need 'chat', as they go to the Orca bot as a message.
    if (!roleAllows(role, permissionForCommand(cmd, isGroup))) {
      const command = /^\/\w+$/.test(cmd) ? cmd : 'a command'
      await this.refuseForRole(token, msg, role, command, command)
      return true
    }
    const binding = await this.resolveBindingBot(await this.getOrCreateBinding(tgChatId, fromId))

    if (cmd === '/start' || cmd === '/help') {
      // The bound chat id and the sync state only for a role that may change them.
      const helpText = this.i18n.help({
        botName: binding.botName,
        ...(roleAllows(role, isGroup ? 'bindGroup' : 'bindPrivate') ? { orcaChatId: binding.orcaChatId } : {}),
        ...(roleAllows(role, 'sync') ? { syncOn: this.config.syncOrcaOutbound } : {}),
        commands: commandsForRole(role, isGroup)
      })
      await this.safeSendTelegram(token, msg.chat.id, helpText, msg.message_id)
      return true
    }

    if (cmd === '/bots') {
      await this.manager.refreshBots()
      const lines = this.bots.length
        ? this.bots.map(
            (b) =>
              `• ${b.name}${b.name === binding.botName ? this.i18n.linkedSuffix : ''}${b.specialty ? ` — ${b.specialty}` : ''}`
          )
        : [this.i18n.noBotsFound]
      await this.safeSendTelegramChunks(token, msg.chat.id, lines.join('\n'), msg.message_id)
      return true
    }

    // This Telegram bot is pinned to one Orca bot; only the owner changes it, in the panel.
    if (cmd === '/use') {
      await this.safeSendTelegram(token, msg.chat.id, this.i18n.botPinned(binding.botName), msg.message_id)
      return true
    }

    if (cmd === '/new') {
      await this.resetChatSessionForBinding(tgChatId, binding)
      await this.safeSendTelegram(
        token,
        msg.chat.id,
        this.i18n.contextReset(binding.botName),
        msg.message_id
      )
      await this.auditTelegram(msg.from, msg.chat, 'new', 'done')
      return true
    }

    if (cmd === '/home') {
      const chats = await this.deps.orcaCli.listBotChats(binding.botName)
      const homeChat = chats.find((c) => c.home && !c.closed)
      if (!homeChat) {
        await this.safeSendTelegram(
          token,
          msg.chat.id,
          this.i18n.homeChatNotFoundFor(binding.botName),
          msg.message_id
        )
        return true
      }
      await this.bindSpecificChat(tgChatId, binding, homeChat)
      await this.safeSendTelegram(
        token,
        msg.chat.id,
        this.i18n.boundHomeChat(binding.botName, homeChat.id),
        msg.message_id
      )
      await this.auditTelegram(msg.from, msg.chat, 'home', 'done', homeChat.id)
      return true
    }

    if (cmd === '/chats') {
      const chats = await this.deps.orcaCli.listBotChats(binding.botName)
      const active = chats.filter((c) => !c.closed).slice(0, 8)
      const lines = active.length
        ? active.map(
            (c) =>
              `• ${c.title || this.i18n.untitledChat}${c.home ? ' [Home]' : ''}${c.id === binding.orcaChatId ? this.i18n.currentSuffix : ''}\n  ID: ${c.id}`
          )
        : [this.i18n.noChats]
      const keyboardRows: TelegramInlineKeyboardButton[][] = active.map((c) => {
        const labelBase = c.home ? '🏠 Home' : (c.title || c.id).slice(0, 28)
        return [
          {
            text: `${c.id === binding.orcaChatId ? '✓ ' : ''}${labelBase}`,
            callback_data: `b:${c.id}`
          }
        ]
      })
      keyboardRows.push([
        { text: '🏠 Home Chat', callback_data: 'c:home' },
        { text: this.i18n.newChatButton, callback_data: 'c:new' }
      ])
      await this.safeSendTelegram(
        token,
        msg.chat.id,
        lines.join('\n'),
        msg.message_id,
        false,
        { inline_keyboard: keyboardRows }
      )
      return true
    }

    if (cmd === '/bind') {
      if (!arg) {
        await this.safeSendTelegram(token, msg.chat.id, this.i18n.bindUsage, msg.message_id)
        return true
      }
      const chats = await this.deps.orcaCli.listBotChats(binding.botName)
      const target = chats.find((c) => c.id === arg && !c.closed)
      if (!target) {
        await this.safeSendTelegram(
          token,
          msg.chat.id,
          this.i18n.chatNotFound(binding.botName, arg),
          msg.message_id
        )
        return true
      }
      await this.bindSpecificChat(tgChatId, binding, target)
      await this.safeSendTelegram(
        token,
        msg.chat.id,
        this.i18n.boundChat(binding.botName, target.title || target.id),
        msg.message_id
      )
      await this.auditTelegram(msg.from, msg.chat, 'bind', 'done', target.id)
      return true
    }

    if (cmd === '/rename') {
      if (!arg) {
        await this.safeSendTelegram(token, msg.chat.id, this.i18n.renameUsage, msg.message_id)
        return true
      }
      if (!binding.orcaChatId) {
        await this.safeSendTelegram(
          token,
          msg.chat.id,
          this.i18n.noBoundChat,
          msg.message_id
        )
        return true
      }
      try {
        await this.deps.orcaCli.renameChat(binding.orcaChatId, arg)
        await this.upsertBinding({
          ...binding,
          title: arg,
          updatedAt: Date.now()
        })
        await this.appendLog('info', 'orca-cli', `Renamed Orca chat ${binding.orcaChatId} (${arg.length} chars).`)
        this.emitState()
        await this.safeSendTelegram(token, msg.chat.id, this.i18n.renamed(arg), msg.message_id)
        // No target: the title is the user's own text.
        await this.auditTelegram(msg.from, msg.chat, 'rename', 'done')
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await this.appendLog(
          'warn',
          'orca-cli',
          `Renaming Orca chat ${binding.orcaChatId} failed: ${message}`,
          describeError(err, { tgChatId, orcaChatId: binding.orcaChatId })
        )
        this.emitState()
        await this.safeSendTelegram(
          token,
          msg.chat.id,
          this.i18n.renameFailed(truncateText(this.redact(message), MAX_DETAIL_CHARS)),
          msg.message_id
        )
      }
      return true
    }

    if (cmd === '/sync') {
      const normalized = arg.toLowerCase()
      if (!normalized) {
        await this.safeSendTelegram(
          token,
          msg.chat.id,
          this.i18n.syncState(this.config.syncOrcaOutbound),
          msg.message_id,
          false,
          {
            inline_keyboard: [
              [
                {
                  text: `${this.config.syncOrcaOutbound ? '✓ ' : ''}${this.i18n.syncOnButton}`,
                  callback_data: 's:on'
                },
                {
                  text: `${!this.config.syncOrcaOutbound ? '✓ ' : ''}${this.i18n.syncOffButton}`,
                  callback_data: 's:off'
                }
              ]
            ]
          }
        )
        return true
      }
      if (['on', 'true', '1', 'enable'].includes(normalized)) {
        await this.setSyncOrcaOutbound(true)
        await this.safeSendTelegram(token, msg.chat.id, this.i18n.syncEnabled, msg.message_id)
        await this.auditTelegram(msg.from, msg.chat, 'sync', 'done', 'on')
        return true
      }
      if (['off', 'false', '0', 'disable'].includes(normalized)) {
        await this.setSyncOrcaOutbound(false)
        await this.safeSendTelegram(token, msg.chat.id, this.i18n.syncDisabled, msg.message_id)
        await this.auditTelegram(msg.from, msg.chat, 'sync', 'done', 'off')
        return true
      }
      await this.safeSendTelegram(token, msg.chat.id, this.i18n.syncUsage, msg.message_id)
      return true
    }

    if (cmd === '/automations') {
      try {
        // Only the automations on this role's list; Run buttons only when the role may run them.
        const automations = (await this.deps.orcaCli.listAutomations()).filter(
          (a) => role.runAutomationIds === null || role.runAutomationIds.includes(a.id)
        )
        if (automations.length === 0) {
          await this.safeSendTelegram(token, msg.chat.id, this.i18n.noAutomations, msg.message_id)
          return true
        }
        const slice = automations.slice(0, 8)
        const lines = slice.map(
          (a) => `• ${a.name} (${this.i18n.automationState(a.enabled, a.lastRunStatus)})\n  ID: ${a.id}`
        )
        const keyboardRows: TelegramInlineKeyboardButton[][] = slice.map((a) => [
          {
            text: this.i18n.runButton(a.name.slice(0, 26)),
            callback_data: `r:${a.id}`
          }
        ])
        await this.safeSendTelegram(
          token,
          msg.chat.id,
          lines.join('\n'),
          msg.message_id,
          false,
          roleAllows(role, 'run') ? { inline_keyboard: keyboardRows } : undefined
        )
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await this.appendLog(
          'warn',
          'orca-cli',
          `Listing Orca automations failed: ${message}`,
          describeError(err, { tgChatId })
        )
        this.emitState()
        await this.safeSendTelegram(
          token,
          msg.chat.id,
          this.i18n.automationsFailed(truncateText(this.redact(message), MAX_DETAIL_CHARS)),
          msg.message_id
        )
      }
      return true
    }

    if (cmd === '/run') {
      if (!arg) {
        await this.safeSendTelegram(
          token,
          msg.chat.id,
          this.i18n.runUsage,
          msg.message_id
        )
        return true
      }
      if (!roleMayRun(role, arg)) {
        await this.refuseForRole(token, msg, role, '/run of an automation not on its list', '/run')
        return true
      }
      try {
        await this.deps.orcaCli.runAutomation(arg)
        await this.appendLog('info', 'orca-cli', `Triggered Orca automation ${arg} from Telegram.`)
        this.emitState()
        await this.safeSendTelegram(token, msg.chat.id, this.i18n.automationTriggered(arg), msg.message_id)
        await this.auditTelegram(msg.from, msg.chat, 'run', 'done', await this.automationName(arg))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await this.appendLog(
          'warn',
          'orca-cli',
          `Running Orca automation ${arg} failed: ${message}`,
          describeError(err, { tgChatId, automationId: arg })
        )
        this.emitState()
        await this.safeSendTelegram(
          token,
          msg.chat.id,
          this.i18n.runFailed(truncateText(this.redact(message), MAX_DETAIL_CHARS)),
          msg.message_id
        )
      }
      return true
    }

    if (cmd === '/status') {
      const statusText = this.i18n.status({
        botUsername: this.botUsername,
        botName: binding.botName,
        // As in /help: the bound chat id and the sync state only for a role that may change them.
        ...(roleAllows(role, isGroup ? 'bindGroup' : 'bindPrivate') ? { orcaChatId: binding.orcaChatId } : {}),
        ...(roleAllows(role, 'sync') ? { syncOn: this.config.syncOrcaOutbound } : {}),
        pollStatus: this.status
      })
      await this.safeSendTelegram(token, msg.chat.id, statusText, msg.message_id)
      return true
    }

    return false
  }

  private async processCallbackQuery(token: string, cq: TelegramCallbackQuery): Promise<void> {
    const msg = cq.message
    const data = cq.data || ''
    if (!msg) return
    const tgChatId = String(msg.chat.id)
    const binding = await this.resolveBindingBot(
      await this.getOrCreateBinding(tgChatId, String(cq.from.id))
    )

    // Switch buttons from /bots messages sent before bridges were pinned.
    if (data.startsWith('u:')) {
      await this.safeAnswerCallbackQuery(token, cq.id, this.i18n.botPinned(binding.botName), true)
      return
    }

    if (data.startsWith('b:')) {
      const chatId = data.slice(2)
      const chats = await this.deps.orcaCli.listBotChats(binding.botName)
      const target = chats.find((c) => c.id === chatId && !c.closed)
      if (!target) {
        await this.safeAnswerCallbackQuery(token, cq.id, this.i18n.chatGoneRetry, true)
        return
      }
      await this.bindSpecificChat(tgChatId, binding, target)
      await this.safeAnswerCallbackQuery(token, cq.id, this.i18n.chatBoundToast)
      await this.safeSendTelegram(
        token,
        msg.chat.id,
        this.i18n.boundChat(binding.botName, target.title || target.id)
      )
      await this.auditTelegram(cq.from, msg.chat, 'bind', 'done', target.id)
      return
    }

    if (data === 'c:new') {
      await this.resetChatSessionForBinding(tgChatId, binding)
      await this.safeAnswerCallbackQuery(token, cq.id, this.i18n.contextResetToast)
      await this.safeSendTelegram(
        token,
        msg.chat.id,
        this.i18n.contextReset(binding.botName)
      )
      await this.auditTelegram(cq.from, msg.chat, 'new', 'done')
      return
    }

    if (data === 'c:home') {
      const chats = await this.deps.orcaCli.listBotChats(binding.botName)
      const homeChat = chats.find((c) => c.home && !c.closed)
      if (!homeChat) {
        await this.safeAnswerCallbackQuery(token, cq.id, this.i18n.homeChatNotFound, true)
        return
      }
      await this.bindSpecificChat(tgChatId, binding, homeChat)
      await this.safeAnswerCallbackQuery(token, cq.id, this.i18n.homeChatBoundToast)
      await this.safeSendTelegram(
        token,
        msg.chat.id,
        this.i18n.boundHomeChat(binding.botName, homeChat.id)
      )
      await this.auditTelegram(cq.from, msg.chat, 'home', 'done', homeChat.id)
      return
    }

    if (data === 's:on' || data === 's:off') {
      const enabled = data === 's:on'
      await this.setSyncOrcaOutbound(enabled)
      await this.safeAnswerCallbackQuery(
        token,
        cq.id,
        enabled ? this.i18n.syncOnToast : this.i18n.syncOffToast
      )
      await this.safeSendTelegram(
        token,
        msg.chat.id,
        enabled ? this.i18n.syncEnabled : this.i18n.syncDisabled
      )
      await this.auditTelegram(cq.from, msg.chat, 'sync', 'done', enabled ? 'on' : 'off')
      return
    }

    if (data.startsWith('r:')) {
      const automationId = data.slice(2)
      try {
        await this.deps.orcaCli.runAutomation(automationId)
        await this.appendLog('info', 'orca-cli', `Triggered Orca automation ${automationId} via Telegram button.`)
        this.emitState()
        await this.safeAnswerCallbackQuery(token, cq.id, this.i18n.automationTriggeredToast)
        await this.safeSendTelegram(token, msg.chat.id, this.i18n.automationTriggered(automationId))
        await this.auditTelegram(cq.from, msg.chat, 'run', 'done', await this.automationName(automationId))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await this.appendLog(
          'warn',
          'orca-cli',
          `Running Orca automation ${automationId} failed: ${message}`,
          describeError(err, { tgChatId: String(msg.chat.id), automationId })
        )
        this.emitState()
        await this.safeAnswerCallbackQuery(token, cq.id, this.i18n.runFailed(this.redact(message).slice(0, 120)), true)
      }
      return
    }

    await this.safeAnswerCallbackQuery(token, cq.id)
  }

  private async resetChatSessionForBinding(tgChatId: string, binding: ChatBinding): Promise<void> {
    await this.upsertBinding({
      tgChatId,
      botId: binding.botId,
      botName: binding.botName,
      orcaChatId: null,
      updatedAt: Date.now()
    })
    await this.pruneUnusedSyncCursors()
    await this.appendLog('info', 'bridge', `Started fresh session binding for Telegram chat ${tgChatId}.`)
    this.emitState()
  }

  private async bindSpecificChat(
    tgChatId: string,
    binding: ChatBinding,
    target: { id: string; title: string; lastActivityAt: number }
  ): Promise<void> {
    await this.upsertBinding({
      tgChatId,
      botId: binding.botId,
      botName: binding.botName,
      orcaChatId: target.id,
      title: target.title,
      updatedAt: Date.now()
    })
    try {
      const snap = await this.deps.orcaCli.readSession(target.id, 80)
      this.syncCursors[target.id] = {
        tailHashes: computeTailHashes(extractMessageItems(snap.entries)),
        ...(snap.state !== 'working' ? { lastActivityAt: target.lastActivityAt } : {}),
        pendingWorking: snap.state === 'working'
      }
      await this.saveSyncCursors()
    } catch (err) {
      // Cursor will baseline on next sync tick if needed.
      await this.appendLog(
        'debug',
        'sync',
        `Reading Orca chat ${target.id} for its sync baseline failed`,
        describeError(err, { tgChatId, orcaChatId: target.id })
      )
    }
    await this.pruneUnusedSyncCursors()
    this.emitState()
  }

  private async setSyncOrcaOutbound(enabled: boolean): Promise<void> {
    const prev = this.config.syncOrcaOutbound
    this.config.syncOrcaOutbound = enabled
    await this.manager.saveBridges()
    if (!prev && enabled) {
      await this.resetSyncCursors()
    }
    if (enabled && this.pollAbort) {
      this.ensureOutboundLoopStarted(this.pollAbort)
    }
    await this.appendLog(
      'info',
      'sync',
      enabled ? 'Enabled Orca -> Telegram outbound sync.' : 'Disabled Orca -> Telegram outbound sync.'
    )
    this.emitState()
  }

  private async safeAnswerCallbackQuery(
    token: string,
    callbackQueryId: string,
    text?: string,
    showAlert = false
  ): Promise<void> {
    try {
      await this.deps.telegram.answerCallbackQuery(
        token,
        { callbackQueryId, text, showAlert },
        { proxyUrl: this.config.proxyUrl, timeoutMs: 10_000 }
      )
    } catch (err) {
      // Non-fatal callback ack failure.
      await this.appendLog(
        'debug',
        'telegram',
        'Answering a Telegram button press failed',
        describeError(err, { callbackId: callbackQueryId })
      )
    }
  }

  private async safeSendTelegram(
    token: string,
    chatId: number | string,
    text: string,
    replyToMessageId?: number,
    formatMarkdown = false,
    replyMarkup?: TelegramInlineKeyboardMarkup
  ): Promise<void> {
    if (formatMarkdown) {
      const html = markdownToTelegramHtml(text)
      if (html.length <= 4096) {
        try {
          await this.deps.telegram.sendMessage(
            token,
            { chatId, text: html, replyToMessageId, parseMode: 'HTML', replyMarkup },
            { proxyUrl: this.config.proxyUrl, timeoutMs: 15_000 }
          )
          return
        } catch (err) {
          // Fall back to plain text below if HTML formatting or length fails.
          await this.appendLog(
            'debug',
            'telegram',
            `HTML reply to chat ${chatId} rejected; resending as plain text`,
            describeError(err, { tgChatId: chatId, htmlLength: html.length })
          )
        }
      }
    }
    try {
      await this.deps.telegram.sendMessage(
        token,
        { chatId, text, replyToMessageId, replyMarkup },
        { proxyUrl: this.config.proxyUrl, timeoutMs: 15_000 }
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await this.appendLog(
        'error',
        'telegram',
        `Failed sending Telegram reply: ${message}`,
        describeError(err, { tgChatId: chatId, textLength: text.length, replyToMessageId })
      )
    }
  }

  // Plain text over Telegram's 4096-char limit is rejected, so long lists go out in chunks.
  private async safeSendTelegramChunks(
    token: string,
    chatId: number | string,
    text: string,
    replyToMessageId?: number,
    replyMarkup?: TelegramInlineKeyboardMarkup
  ): Promise<void> {
    const chunks = splitTelegramMessage(text, 3500)
    for (let i = 0; i < chunks.length; i++) {
      await this.safeSendTelegram(
        token,
        chatId,
        chunks[i],
        i === 0 ? replyToMessageId : undefined,
        false,
        i === chunks.length - 1 ? replyMarkup : undefined
      )
    }
  }

  private async safeSendTelegramPhoto(
    token: string,
    chatId: number | string,
    photo: Buffer,
    filename: string,
    caption?: string
  ): Promise<void> {
    try {
      await this.deps.telegram.sendPhoto(
        token,
        { chatId, photo, filename, caption },
        { proxyUrl: this.config.proxyUrl, timeoutMs: 25_000 }
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await this.appendLog(
        'error',
        'telegram',
        `Failed sending Telegram table image: ${message}`,
        describeError(err, { tgChatId: chatId, bytes: photo.length })
      )
    }
  }

  private async ensureCommandsRegistered(token: string, signal?: AbortSignal): Promise<void> {
    if (this.commandsRegistered) return
    const key = menuKey(this.config)
    const { replyLanguage: setting, roles, roleAssignments } = this.config
    const openToEveryone = !this.config.restricted
    const options = { proxyUrl: this.config.proxyUrl, timeoutMs: 10_000, signal }
    // Every language's menu is set each time, so leaving 'auto' replaces the per-language menus too.
    const menus: Array<[code: string | undefined, language: ReplyLanguage]> = [
      [undefined, setting === 'auto' ? 'en' : setting],
      ...MENU_LANGUAGES.map(([code, language]): [string, ReplyLanguage] => [code, setting === 'auto' ? language : setting])
    ]
    // One menu (the default, or one chat's) in every menu language, listing what that role may use.
    const setMenus = async (role: BridgeRole, isGroup: boolean, scope?: TelegramBotCommandScope) => {
      const names = commandsForRole(role, isGroup)
      for (const [code, language] of menus) {
        const commands: TelegramBotCommand[] = names.map((command) => ({ command, description: t(language).commands[command] }))
        await this.deps.telegram.setMyCommands(token, commands, options, code, scope)
      }
    }
    try {
      // The default menu is for everyone without a role of their own: Stranger while open, else Member.
      await setMenus(resolveRole(roles, {}, { senderId: '', chatId: '', isGroup: false, openToEveryone }), false)
      this.lastFailures.delete('setMyCommands')
    } catch (err) {
      // Retried on every poll until it works; logged again only when the failure changes.
      if (this.isRepeatedFailure('setMyCommands', err)) return
      const message = err instanceof Error ? err.message : String(err)
      await this.appendLog('warn', 'telegram', `Failed to register Telegram commands: ${message}`, describeError(err))
      return
    }

    // One menu per person or group with a role: a user id is their private chat, a group id the group.
    const ids = Object.keys(roleAssignments)
    const unset = new Set<string>()
    for (const id of ids) {
      const isGroup = id.startsWith('-')
      const site = `setMyCommands:${id}`
      try {
        const role = resolveRole(roles, roleAssignments, { senderId: id, chatId: id, isGroup, openToEveryone })
        await setMenus(role, isGroup, { type: 'chat', chat_id: Number(id) })
        this.lastFailures.delete(site)
      } catch (err) {
        if (signal?.aborted) return
        // Usually "chat not found": Telegram knows no chat with a person until they write to the bot.
        // Their next message makes the next poll try again.
        unset.add(id)
        if (this.isRepeatedFailure(site, err)) continue
        const message = err instanceof Error ? err.message : String(err)
        await this.appendLog(
          'warn',
          'telegram',
          `Could not set the command menu of chat ${id}: ${message}`,
          describeError(err, { tgChatId: id })
        )
      }
    }

    // Ids that lost their role (or were removed) fall back to the default menu.
    const notRemoved: string[] = []
    for (const id of this.commandScopeIds.filter((scopeId) => !roleAssignments[scopeId])) {
      try {
        for (const [code] of menus) {
          await this.deps.telegram.deleteMyCommands(token, options, { type: 'chat', chat_id: Number(id) }, code)
        }
      } catch (err) {
        if (signal?.aborted) return
        // Kept in the list, so the next registration tries again.
        notRemoved.push(id)
        const message = err instanceof Error ? err.message : String(err)
        await this.appendLog(
          'warn',
          'telegram',
          `Could not remove the command menu of chat ${id}: ${message}`,
          describeError(err, { tgChatId: id })
        )
      }
    }
    // A menu set before and failing now may still be there; it stays listed so a removal deletes it.
    const before = this.commandScopeIds
    this.commandScopeIds = [...ids.filter((id) => !unset.has(id) || before.includes(id)), ...notRemoved]
    this.unsetScopeIds = unset
    try {
      await this.orca.storage.set(this.key('commandScopes'), this.commandScopeIds)
    } catch (err) {
      await this.appendLog('warn', 'telegram', 'Could not store which chats have their own command menu', describeError(err))
    }
    // A change during the calls leaves the flag unset, so the next poll sends the new menus.
    this.commandsRegistered = key === menuKey(this.config)
    await this.appendLog(
      'info',
      'telegram',
      `Registered Telegram slash command menu (${setting}${ids.length > 0 ? `, ${ids.length - unset.size} of ${ids.length} chat menu(s)` : ''}).`
    )
  }

  private startPolling(): void {
    if (this.disposed || this.pollAbort) return
    const abort = new AbortController()
    this.pollAbort = abort
    this.status = 'connecting'
    this.lastError = null
    this.emitState()

    const loop = this.runPollLoop(abort).finally(() => {
      // The loop also ends on its own (401, no token); abort so the outbound loop and queued replies stop.
      abort.abort()
      if (this.pollAbort === abort) {
        this.pollAbort = null
      }
      if (this.pollLoopPromise === loop) {
        this.pollLoopPromise = null
      }
    })
    this.pollLoopPromise = loop

    if (this.config.syncOrcaOutbound) {
      this.ensureOutboundLoopStarted(abort)
    }
  }

  private ensureOutboundLoopStarted(abort: AbortController): void {
    if (this.disposed || this.outboundLoopAbort === abort) return
    // The loop of an aborted controller may still be finishing a tick; run the new loop after it.
    const prev = this.outboundLoopPromise ?? Promise.resolve()
    const loop = prev
      .then(() => this.runOutboundSyncLoop(abort))
      .finally(() => {
        if (this.outboundLoopPromise === loop) {
          this.outboundLoopPromise = null
          this.outboundLoopAbort = null
        }
      })
    this.outboundLoopAbort = abort
    this.outboundLoopPromise = loop
  }

  private async stopPolling(): Promise<void> {
    // Read the loops before awaiting: loops of a restart during the wait are not ours to wait for.
    const loops = [this.pollLoopPromise, this.outboundLoopPromise]
    this.pollAbort?.abort()
    this.pollAbort = null
    await Promise.all(loops)
    // Replies still running in chat queues got the aborted poll signal; wait for them to settle.
    await Promise.all(this.chatQueues.values())
  }

  private async runOutboundSyncLoop(abort: AbortController): Promise<void> {
    const intervalMs = this.deps.outboundPollIntervalMs ?? 3000
    while (!abort.signal.aborted && !this.disposed) {
      await sleep(intervalMs, abort.signal)
      if (abort.signal.aborted || this.disposed) break
      if (!this.config.syncOrcaOutbound || !this.config.enabled) continue
      try {
        await this.syncOrcaBoundChatsOnce()
        this.lastFailures.delete('outboundSync')
      } catch (err) {
        if (abort.signal.aborted || this.disposed) break
        // A failing tick repeats every few seconds; log it again only when the failure changes.
        if (this.isRepeatedFailure('outboundSync', err)) continue
        const msg = err instanceof Error ? err.message : String(err)
        await this.appendLog('warn', 'sync', `Orca outbound sync error: ${msg}`, describeError(err))
        this.emitState()
      }
    }
  }

  // Outbound sync never runs while the bridge is open; say so once when that state begins.
  private async logSyncPausedWhileOpen(changed: string[]): Promise<void> {
    if (!this.config.syncOrcaOutbound || this.config.restricted) return
    if (!changed.includes('syncOrcaOutbound') && !changed.includes('restricted')) return
    await this.appendLog(
      'info',
      'sync',
      'Orca outbound sync is paused: the bridge is open to everyone. Choose Only these people and groups to use sync.'
    )
  }

  async syncOrcaBoundChatsOnce(): Promise<void> {
    if (this.disposed || !this.config.syncOrcaOutbound || this.outboundSyncRunning) return
    const token = await this.readToken()
    if (!token) return
    // Open mode lets anyone /bind an Orca chat; syncing would push the owner's Orca messages to them.
    if (!this.config.restricted) return
    const allowed = parseAllowedIds(this.config.allowedUserIds)

    // Sync only to chats whose Telegram user (or group) is still on the allowlist, and to groups
    // only while groups are on.
    const boundList = this.bindings.filter(
      (b) =>
        Boolean(b.orcaChatId) &&
        (this.config.allowGroups || !b.tgChatId.startsWith('-')) &&
        (allowed.has(b.tgChatId) || (b.ownerUserId !== undefined && allowed.has(b.ownerUserId)))
    )
    if (boundList.length === 0) return

    this.outboundSyncRunning = true
    // Automation runs are read at most once per sync cycle, shared by every bound chat.
    this.automationSnapshot = null
    try {
      await this.manager.refreshBots()
      const byBot = new Map<string, ChatBinding[]>()
      for (const rawBinding of boundList) {
        const binding = await this.resolveBindingFromCachedBots(rawBinding)
        if (!binding.orcaChatId || !binding.botName) continue
        if (
          this.activeTelegramTgChats.has(binding.tgChatId) ||
          this.activeTelegramOrcaChats.has(binding.orcaChatId)
        ) {
          continue
        }
        const list = byBot.get(binding.botName) ?? []
        list.push(binding)
        byBot.set(binding.botName, list)
      }

      for (const [botName, bindings] of byBot.entries()) {
        if (this.disposed) break
        let chats
        try {
          chats = await this.deps.orcaCli.listBotChats(botName)
          this.lastFailures.delete(`syncChats:${botName}`)
        } catch (err) {
          if (!this.isRepeatedFailure(`syncChats:${botName}`, err)) {
            await this.appendLog(
              'debug',
              'sync',
              `Sync skipped bot ${botName}: listing its chats failed`,
              describeError(err, { bot: botName })
            )
          }
          continue
        }
        const chatMap = new Map(chats.map((c) => [c.id, c]))

        for (const binding of bindings) {
          const orcaChatId = binding.orcaChatId
          if (!orcaChatId) continue
          if (
            this.activeTelegramTgChats.has(binding.tgChatId) ||
            this.activeTelegramOrcaChats.has(orcaChatId)
          ) {
            continue
          }
          const chatMeta = chatMap.get(orcaChatId)
          if (!chatMeta || chatMeta.closed) continue
          // Sync speaks unprompted, so 'auto' uses the chat's last seen Telegram language.
          await messageLanguage.run(this.chatLanguages.get(binding.tgChatId) ?? 'en', () =>
            this.syncSingleBoundChat(token, binding, orcaChatId, chatMeta.lastActivityAt)
          )
        }
      }
    } finally {
      this.outboundSyncRunning = false
    }
  }

  /**
   * The prompts of automations that ran in this Orca chat within a day. A scheduled run in a reused
   * chat reaches it as the automation's prompt with no marker (upstream
   * automation-chat-session-reuse.ts), so a typed-looking message counts as a run only when its text
   * is that prompt and that automation ran in this very chat. Empty when Orca cannot be read.
   */
  private async scheduledRunPrompts(orcaChatId: string): Promise<Set<string>> {
    this.automationSnapshot ??= this.readAutomationSnapshot()
    const snapshot = await this.automationSnapshot
    if (!snapshot) return new Set()
    const since = Date.now() - AUTOMATION_RUN_WINDOW_MS
    const ranHere = new Set(
      snapshot.runs
        .filter((run) => run.chatSessionId === orcaChatId && run.startedAt !== null && run.startedAt >= since)
        .map((run) => run.automationId)
    )
    return new Set(
      snapshot.automations.flatMap((a) =>
        ranHere.has(a.id) && a.prompt?.trim() ? [normalizePrompt(a.prompt)] : []
      )
    )
  }

  /** Orca's recent automation runs and automations, or null (logged) when they cannot be read. */
  private async readAutomationSnapshot(): Promise<AutomationSnapshot | null> {
    try {
      const [runs, automations] = await Promise.all([
        this.deps.orcaCli.listAutomationRuns(AUTOMATION_RUNS_LIMIT),
        this.deps.orcaCli.listAutomations()
      ])
      return { runs, automations }
    } catch (err) {
      await this.appendLog('warn', 'sync', 'Could not read Orca automation runs', describeError(err))
      return null
    }
  }

  private async syncSingleBoundChat(
    token: string,
    binding: ChatBinding,
    orcaChatId: string,
    lastActivityAt: number
  ): Promise<void> {
    const existing = this.syncCursors[orcaChatId]
    if (existing && !existing.pendingWorking && existing.lastActivityAt === lastActivityAt) {
      return
    }

    const startedAt = Date.now()
    let session
    try {
      session = await this.deps.orcaCli.readSession(orcaChatId, 80)
      this.lastFailures.delete(`syncRead:${orcaChatId}`)
    } catch (err) {
      if (!this.isRepeatedFailure(`syncRead:${orcaChatId}`, err)) {
        await this.appendLog(
          'debug',
          'sync',
          `Sync skipped Orca chat ${orcaChatId}: reading it failed`,
          describeError(err, { tgChatId: binding.tgChatId, bot: binding.botName, orcaChatId })
        )
      }
      return
    }

    const items = extractMessageItems(session.entries)
    const isWorking = session.state === 'working'

    if (!existing) {
      this.syncCursors[orcaChatId] = {
        tailHashes: computeTailHashes(items),
        ...(isWorking ? {} : { lastActivityAt }),
        pendingWorking: isWorking
      }
      await this.saveSyncCursors()
      return
    }

    const { matched, unsynced } = findUnsyncedTail(items, existing.tailHashes)
    if (!matched) {
      this.syncCursors[orcaChatId] = {
        tailHashes: computeTailHashes(items),
        ...(isWorking ? {} : { lastActivityAt }),
        pendingWorking: isWorking
      }
      await this.saveSyncCursors()
      return
    }

    if (unsynced.length === 0) {
      this.syncCursors[orcaChatId] = {
        tailHashes: existing.tailHashes,
        ...(isWorking ? {} : { lastActivityAt }),
        pendingWorking: isWorking
      }
      await this.saveSyncCursors()
      return
    }

    let readyItems: OrcaMessageItem[] = unsynced
    if (isWorking) {
      // While the bot is still generating, only flush up to the last user prompt;
      // wait for completion before forwarding assistant messages.
      let lastUserIdx = -1
      for (let i = unsynced.length - 1; i >= 0; i--) {
        if (unsynced[i].role === 'user') {
          lastUserIdx = i
          break
        }
      }
      if (lastUserIdx < 0) {
        this.syncCursors[orcaChatId] = {
          tailHashes: existing.tailHashes,
          pendingWorking: true
        }
        await this.saveSyncCursors()
        return
      }
      readyItems = unsynced.slice(0, lastUserIdx + 1)
    }

    if (readyItems.length === 0) return

    let forwardedUserCount = 0
    let forwardedAssistantCount = 0
    // Built once per chat, only when a message may be a scheduled run.
    let scheduledPrompts: Set<string> | undefined

    // Group consecutive assistant messages so multi-step tool turns arrive as one clean reply.
    for (let i = 0; i < readyItems.length; i++) {
      const item = readyItems[i]
      if (item.role === 'user') {
        // Orca's own automation runs (reminders, deadlines, events, scheduled runs) and mail from
        // other agents are not something the owner typed.
        const typedInOrca =
          !isTelegramOriginatedUserMessage(item.text) &&
          !isOrcaAutomationRunMessage(item.text) &&
          !isOrcaOrchestrationMailMessage(item.text) &&
          !(scheduledPrompts ??= await this.scheduledRunPrompts(orcaChatId)).has(normalizePrompt(item.text))
        if (typedInOrca) {
          const userPayload = `${this.i18n.orcaUserMessageHeader(binding.botName)}\n\n${item.text}`
          const chunks = splitTelegramMessage(userPayload, 3500)
          for (const chunk of chunks) {
            await this.safeSendTelegram(token, binding.tgChatId, chunk, undefined, true)
          }
          forwardedUserCount++
        }
        continue
      }

      const assistantParts = [item.text]
      while (i + 1 < readyItems.length && readyItems[i + 1].role === 'assistant') {
        i++
        assistantParts.push(readyItems[i].text)
      }
      // NO_REPLY parts say nothing, as in Orca's own chat.
      const shown = assistantParts
        .map((part) => withoutQuietMarker(part))
        .filter((part): part is string => part !== null)
      if (shown.length === 0) continue
      await this.sendFormattedReplyToTelegram(token, binding.tgChatId, shown.join('\n\n'))
      forwardedAssistantCount++
    }

    const unconsumedCount = unsynced.length - readyItems.length
    const syncedPrefix = unconsumedCount > 0 ? items.slice(0, items.length - unconsumedCount) : items
    const stillPending = isWorking || unconsumedCount > 0

    this.syncCursors[orcaChatId] = {
      tailHashes: computeTailHashes(syncedPrefix),
      ...(stillPending ? {} : { lastActivityAt }),
      pendingWorking: stillPending
    }
    await this.saveSyncCursors()

    if (forwardedUserCount > 0 || forwardedAssistantCount > 0) {
      await this.appendLog(
        'info',
        'sync',
        `[Orca -> TG ${binding.tgChatId}] Synced ${forwardedUserCount} user + ${forwardedAssistantCount} assistant message(s) from ${binding.botName}.`
      )
      await this.appendLog(
        'debug',
        'sync',
        `Sync tick for Orca chat ${orcaChatId} forwarded ${readyItems.length} item(s) in ${
          Date.now() - startedAt
        } ms: ${session.entries.length} entries read, state ${session.state ?? 'unknown'}, ${
          stillPending ? 'more pending' : 'caught up'
        }`
      )
      this.emitState()
    }
  }

  private async resetSyncCursors(): Promise<void> {
    this.syncCursors = {}
    await this.saveSyncCursors()
  }

  private async pruneUnusedSyncCursors(): Promise<void> {
    const activeIds = new Set(
      this.bindings.map((b) => b.orcaChatId).filter((id): id is string => Boolean(id))
    )
    let changed = false
    for (const chatId of Object.keys(this.syncCursors)) {
      if (!activeIds.has(chatId)) {
        delete this.syncCursors[chatId]
        changed = true
      }
    }
    if (changed) {
      await this.saveSyncCursors()
    }
  }

  private async saveSyncCursors(): Promise<void> {
    try {
      await this.orca.storage.set(this.key('syncCursors'), toPlainJson(this.syncCursors))
    } catch (err) {
      // Non-fatal in mock/read-only runs.
      await this.appendLog('debug', 'sync', 'Saving sync cursors failed', describeError(err))
    }
  }

  private async runPollLoop(abort: AbortController): Promise<void> {
    await this.appendLog('debug', 'telegram', `Poll loop started at offset ${this.updateOffset}`)
    let stopReason: string | null = null
    try {
      stopReason = await this.pollUntilStopped(abort)
    } finally {
      await this.appendLog(
        'debug',
        'telegram',
        `Poll loop stopped: ${stopReason ?? (this.disposed ? 'disposed' : 'aborted')}`
      )
    }
  }

  // Returns why it stopped on its own, or null when aborted or disposed.
  private async pollUntilStopped(abort: AbortController): Promise<string | null> {
    let backoffMs = this.deps.retryBackoffMs ?? 2000

    while (!abort.signal.aborted && !this.disposed) {
      const token = await this.readToken()
      if (!token) {
        this.status = 'needs_token'
        this.emitState()
        return 'no bot token'
      }

      try {
        if (!this.botUsername) {
          this.rememberBot(
            await this.deps.telegram.getMe(token, {
              proxyUrl: this.config.proxyUrl,
              timeoutMs: 12_000,
              signal: abort.signal
            })
          )
          this.lookUpMissingNames(token)
        }

        await this.ensureCommandsRegistered(token, abort.signal)

        // While not yet connected, a short poll confirms the connection right away instead of
        // leaving the status on "connecting" for a whole 25s long poll.
        const updates = await this.deps.telegram.getUpdates(
          token,
          {
            offset: this.updateOffset || undefined,
            timeoutSec: this.status === 'connected' ? 25 : 0
          },
          { proxyUrl: this.config.proxyUrl, signal: abort.signal }
        )

        this.lastPollAt = Date.now()
        backoffMs = this.deps.retryBackoffMs ?? 2000

        // Only a successful getUpdates proves the connection (a second poller gets 409 here).
        if (this.status !== 'connected') {
          this.status = 'connected'
          this.lastError = null
          await this.appendLog(
            'info',
            'telegram',
            `Connected to Telegram as @${this.botUsername || 'bot'}.`
          )
          this.emitState()
        }

        for (const update of updates) {
          if (abort.signal.aborted || this.disposed) break
          await this.acceptIncomingUpdate(update, abort.signal)
        }
      } catch (err) {
        if (abort.signal.aborted || this.disposed) break
        const message = err instanceof Error ? err.message : String(err)
        const isAuthError = err instanceof TelegramApiError && err.statusCode === 401
        this.status = 'error'
        this.lastError = message
        await this.appendLog(
          'error',
          'telegram',
          `Polling error: ${message}`,
          describeError(err, { offset: this.updateOffset, backoffMs: isAuthError ? null : backoffMs })
        )
        this.emitState()

        if (isAuthError) {
          return 'Telegram rejected the bot token (401)'
        }
        await this.appendLog('debug', 'telegram', `Poll loop backing off ${backoffMs} ms`)
        await sleep(backoffMs, abort.signal)
        backoffMs = Math.min(30_000, backoffMs * 2)
      }
    }
    return null
  }

  // Runtime state is read once at init; afterwards memory owns it and storage is write-through.
  private async loadRuntimeState(): Promise<void> {
    const savedOffset = await this.orca.storage.get(this.key('offset'))
    this.updateOffset = typeof savedOffset === 'number' ? savedOffset : 0

    const savedBindings = await this.orca.storage.get(this.key('bindings'))
    this.bindings = Array.isArray(savedBindings) ? (savedBindings as ChatBinding[]) : []

    const savedBlocked = await this.orca.storage.get(this.key('lastBlocked'))
    this.lastBlockedUserId = typeof savedBlocked === 'string' ? savedBlocked : null

    const savedCursors = await this.orca.storage.get(this.key('syncCursors'))
    this.syncCursors =
      savedCursors && typeof savedCursors === 'object' && !Array.isArray(savedCursors)
        ? (savedCursors as Record<string, SyncCursor>)
        : {}

    const savedLanguages = await this.orca.storage.get(this.key('chatLanguages'))
    this.chatLanguages.clear()
    if (savedLanguages && typeof savedLanguages === 'object' && !Array.isArray(savedLanguages)) {
      for (const [chatId, language] of Object.entries(savedLanguages)) {
        if (REPLY_LANGUAGES.includes(language as ReplyLanguage)) this.chatLanguages.set(chatId, language as ReplyLanguage)
      }
    }

    // The pinned bot's id, from a chat that talked to it, so a rename in Orca before the first
    // bot list is still followed.
    if (this.config.orcaBot) {
      this.pinnedBotId =
        this.bindings.find((b) => b.botName === this.config.orcaBot && b.botId)?.botId ?? null
    }

    const savedScopes = await this.orca.storage.get(this.key('commandScopes'))
    this.commandScopeIds = Array.isArray(savedScopes)
      ? savedScopes.filter((id): id is string => typeof id === 'string' && /^-?\d+$/.test(id))
      : []

    const savedNames = await this.orca.storage.get(this.key('knownNames'))
    this.knownNames.clear()
    if (savedNames && typeof savedNames === 'object' && !Array.isArray(savedNames)) {
      for (const [id, name] of Object.entries(savedNames)) {
        if (typeof name === 'string' && name) this.knownNames.set(id, name)
      }
    }

    if (this.seedRolesFromBindings) await this.seedFullAccessFromBindings()
  }

  // Before roles, everyone who could talk had every command. An open bridge has no list to carry
  // over, so the people who already chatted with it in private (their bindings) keep full access.
  // A restricted bridge is skipped: its list already holds everyone allowed, and assigning a
  // removed person a role would put them back on the list at the next save.
  private async seedFullAccessFromBindings(): Promise<void> {
    this.seedRolesFromBindings = false
    if (!this.config.restricted) {
      const assignments = { ...this.config.roleAssignments }
      for (const b of this.bindings) {
        if (!/^\d+$/.test(b.tgChatId)) continue
        for (const userId of [b.tgChatId, b.ownerUserId]) {
          if (userId && /^\d+$/.test(userId) && !assignments[userId]) assignments[userId] = FULL_ROLE_ID
        }
      }
      this.config.roleAssignments = assignments
    }
    await this.manager.saveBridges()
  }

  // The language a chat last showed, kept so 'auto' still knows it after a restart, for a message
  // without a Telegram language, and for what sync sends there unprompted. Best effort: the update
  // offset has already moved on, so a failed write must not drop the message.
  private async rememberChatLanguage(tgChatId: string, language: ReplyLanguage): Promise<void> {
    if (this.chatLanguages.get(tgChatId) === language) return
    this.chatLanguages.set(tgChatId, language)
    try {
      await this.orca.storage.set(this.key('chatLanguages'), toPlainJson(Object.fromEntries(this.chatLanguages)))
    } catch (err) {
      await this.appendLog('warn', 'bridge', `Could not store the language of Telegram chat ${tgChatId}`, describeError(err))
    }
  }

  // Keeps the name of a listed sender and of a listed group, when new or changed. Strangers are
  // never stored, even on an open bridge.
  private async rememberNames(update: TelegramUpdate): Promise<void> {
    const listed = listedIds(this.config)
    const from = update.message?.from ?? update.callback_query?.from ?? update.my_chat_member?.from
    const chat = update.message?.chat ?? update.my_chat_member?.chat
    const found: [string, string][] = []
    if (from) found.push([String(from.id), personName(from)])
    if (chat && isGroupChat(chat)) found.push([String(chat.id), (chat.title ?? '').trim()])
    let changed = false
    for (const [id, name] of found) {
      if (!name || !listed.has(id) || this.knownNames.get(id) === name) continue
      this.knownNames.set(id, name)
      changed = true
    }
    if (!changed) return
    await this.saveKnownNames()
    this.emitState()
  }

  // Asks Telegram for the names of the listed ids that have none, one after another, at most
  // MAX_NAME_LOOKUPS per run. A person who never opened the bot, or a group without it, fails with
  // 400/403: that id stays blank until the next connect or save, so a failure never loops. Runs in
  // the background so a slow Telegram holds up neither polling nor a save; runs queue, never overlap.
  private lookUpMissingNames(token: string): void {
    this.nameLookups = this.nameLookups.then(() => this.lookUpMissingNamesNow(token)).catch(() => {})
  }

  private async lookUpMissingNamesNow(token: string): Promise<void> {
    const missing = [...listedIds(this.config)].filter((id) => !this.knownNames.has(id)).slice(0, MAX_NAME_LOOKUPS)
    let changed = false
    for (const id of missing) {
      let chat: TelegramChat
      try {
        chat = await this.deps.telegram.getChat(token, Number(id), { proxyUrl: this.config.proxyUrl, timeoutMs: 12_000 })
      } catch (err) {
        if (this.disposed) return
        await this.appendLog('debug', 'telegram', `No name for Telegram ID ${id}: getChat failed`, describeError(err))
        continue
      }
      // A removed bridge must not write its names back; the list may also have changed meanwhile.
      if (this.disposed) return
      const name = chat.type === 'private' ? personName(chat) : (chat.title ?? '').trim()
      if (!name || !listedIds(this.config).has(id) || this.knownNames.get(id) === name) continue
      this.knownNames.set(id, name)
      changed = true
    }
    if (!changed) return
    await this.saveKnownNames()
    this.emitState()
  }

  // Best effort: a name is only shown in the editor, so a failed write is not worth a warning.
  private async saveKnownNames(): Promise<void> {
    try {
      await this.orca.storage.set(this.key('knownNames'), toPlainJson(Object.fromEntries(this.knownNames)))
    } catch (err) {
      await this.appendLog('debug', 'bridge', 'Storing the names of the listed Telegram IDs failed', describeError(err))
    }
  }

  private async readToken(): Promise<string | null> {
    try {
      const value = await this.orca.secrets.get(bridgeSecretKey(this.id))
      this.cachedToken = value && value.trim() ? value.trim() : null
      this.lastFailures.delete('readToken')
      return this.cachedToken
    } catch (err) {
      // Read on every poll; a failing secret store is logged again only when the failure changes.
      if (!this.isRepeatedFailure('readToken', err)) {
        await this.appendLog('debug', 'config', 'Reading the bot token failed; using the cached one', describeError(err))
      }
      return this.cachedToken
    }
  }

  private async readVoiceKey(): Promise<string | null> {
    try {
      const value = (await this.orca.secrets.get(voiceSecretKey(this.id)))?.trim() || null
      if (value !== this.cachedVoiceKey) this.retireVoiceKey()
      this.cachedVoiceKey = value
      this.config.hasVoiceKey = Boolean(value)
      return value
    } catch (err) {
      await this.appendLog('debug', 'config', 'Reading the voice API key failed; using the cached one', describeError(err))
      return this.cachedVoiceKey
    }
  }

  // A replaced voice key stays redacted: an error from a call still using it must not leak it.
  private retireVoiceKey(): void {
    if (this.cachedVoiceKey) this.manager.formerVoiceKeys.push(this.cachedVoiceKey)
    this.cachedVoiceKey = null
  }

  // updateOffset, the @username and the command menu belong to one bot; a new token starts them over.
  private async adoptToken(token: string | null): Promise<void> {
    if (token === this.identityToken) return
    this.identityToken = token
    this.updateOffset = 0
    this.botUsername = null
    this.botUserId = null
    this.botDisplayName = null
    this.telegramCaps = null
    this.commandsRegistered = false
    await this.orca.storage.set(this.key('offset'), 0)
  }

  private rememberBot(me: TelegramUser): void {
    this.botUsername = me.username || null
    this.botUserId = me.id
    this.botDisplayName = me.first_name
    this.telegramCaps = {
      canJoinGroups: me.can_join_groups === true,
      canReadAllGroupMessages: me.can_read_all_group_messages === true
    }
  }

  // The Orca bot this bridge talks to: the chosen one, or the first bot when none is chosen. A bot
  // renamed in Orca is followed by its id. Without a bot list (none yet, or listing failed) the
  // chosen name is used as it is.
  private async pinnedBot(): Promise<{ id?: string; name: string }> {
    const bots = this.bots
    if (!this.config.orcaBot) {
      return bots[0] ? { id: bots[0].id, name: bots[0].name } : { name: '' }
    }
    const byName = bots.find((b) => b.name === this.config.orcaBot)
    if (byName) {
      this.pinnedBotId = byName.id
      return { id: byName.id, name: byName.name }
    }
    const renamed = this.pinnedBotId ? bots.find((b) => b.id === this.pinnedBotId) : undefined
    if (!renamed) return { name: this.config.orcaBot }
    const oldName = this.config.orcaBot
    this.config.orcaBot = renamed.name
    await this.manager.saveBridges()
    await this.appendLog('info', 'bridge', `Orca bot "${oldName}" is now named "${renamed.name}"; the bridge follows it.`)
    this.emitState()
    return { id: renamed.id, name: renamed.name }
  }

  private async resolveBindingBot(binding: ChatBinding): Promise<ChatBinding> {
    await this.manager.refreshBots()
    return this.resolveBindingFromCachedBots(binding)
  }

  // Every binding talks to the pinned bot. A binding left on another bot (from /use before 0.5.0, or
  // a pinned bot changed in the panel) moves to it and starts a new chat: the old chat is not its.
  private async resolveBindingFromCachedBots(binding: ChatBinding): Promise<ChatBinding> {
    const target = await this.pinnedBot()
    if (!target.name) return binding
    const sameName = binding.botName === target.name
    if (sameName && (target.id === undefined || binding.botId === target.id)) return binding
    // The same bot under a new name, or a new id under the same name, keeps its chat.
    const keepChat = sameName || (target.id !== undefined && binding.botId === target.id)
    const updated: ChatBinding = {
      tgChatId: binding.tgChatId,
      ownerUserId: binding.ownerUserId,
      botId: target.id,
      botName: target.name,
      orcaChatId: keepChat ? binding.orcaChatId : null,
      title: keepChat ? binding.title : undefined,
      updatedAt: Date.now()
    }
    await this.upsertBinding(updated)
    if (!keepChat) {
      await this.pruneUnusedSyncCursors()
      await this.appendLog(
        'info',
        'bridge',
        `Moved Telegram chat ${binding.tgChatId} from "${binding.botName}" to the linked Orca bot "${target.name}".`
      )
      this.emitState()
    }
    return updated
  }

  private async getOrCreateBinding(tgChatId: string, ownerUserId: string): Promise<ChatBinding> {
    const existing = this.bindings.find((b) => b.tgChatId === tgChatId)
    if (existing) {
      if (existing.ownerUserId === ownerUserId) return existing
      const owned: ChatBinding = { ...existing, ownerUserId }
      await this.upsertBinding(owned)
      return owned
    }
    const target = await this.pinnedBot()
    const created: ChatBinding = {
      tgChatId,
      ownerUserId,
      botId: target.id,
      botName: target.name,
      orcaChatId: null,
      updatedAt: Date.now()
    }
    await this.upsertBinding(created)
    return created
  }

  // After an answer: an Orca chat still under Orca's automatic title gets "telegram@<name>", so the
  // owner can tell the bridged chats apart in Orca's sidebar. Best effort; a failure only logs.
  private async nameOrcaChat(
    msg: TelegramMessage,
    tgChatId: string,
    binding: ChatBinding,
    orcaChatId: string,
    title: string | undefined
  ): Promise<void> {
    if (!isAutomaticChatTitle(title)) return
    const name = orcaChatNameFor(msg)
    if (!name) return
    try {
      await this.deps.orcaCli.renameChat(orcaChatId, name)
      await this.upsertBinding({ ...binding, orcaChatId, title: name, updatedAt: Date.now() })
      await this.appendLog('debug', 'orca-cli', `Named Orca chat ${orcaChatId} after the Telegram chat ${tgChatId}.`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await this.appendLog(
        'debug',
        'orca-cli',
        `Naming Orca chat ${orcaChatId} failed: ${message}`,
        describeError(err, { tgChatId, orcaChatId })
      )
    }
  }

  private async upsertBinding(binding: ChatBinding): Promise<void> {
    const idx = this.bindings.findIndex((b) => b.tgChatId === binding.tgChatId)
    if (idx >= 0) {
      // Callers rebuild bindings field by field; keep the owner unless they set a new one.
      const ownerUserId = binding.ownerUserId ?? this.bindings[idx].ownerUserId
      this.bindings[idx] = ownerUserId === undefined ? binding : { ...binding, ownerUserId }
    } else {
      this.bindings.push(binding)
    }
    await this.orca.storage.set(this.key('bindings'), toPlainJson(this.bindings))
  }

  private appendLog(level: BridgeLogEntry['level'], scope: LogScope, message: string, details?: string): Promise<void> {
    return this.manager.appendLog(level, scope, message, details, this.id)
  }

  private redact(text: string): string {
    return this.manager.redact(text)
  }

  private isRepeatedFailure(site: string, err: unknown): boolean {
    return isRepeatedFailure(this.lastFailures, site, err)
  }

  private updateInitialStatus(): void {
    if (!this.config.hasToken) {
      this.status = 'needs_token'
    } else if (!this.config.enabled) {
      this.status = 'stopped'
    } else {
      this.status = 'connecting'
    }
  }

  private emitState(): void {
    this.manager.emitState()
  }
}

// Failures retried every few seconds are logged once until their message changes or the call
// succeeds again (the caller then deletes the site).
function isRepeatedFailure(failures: Map<string, string>, site: string, err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  if (failures.get(site) === message) return true
  failures.set(site, message)
  return false
}

// Set before the 0.4.0 settings are copied into "Bridge 1" and cleared last, so a start after a
// crash in the middle resumes the same bridge instead of making a second one.
const STORAGE_MIGRATION_ID = 'migration.bridgeId'

// Runs every bridge side by side and owns what they share: the bridge list, the Orca bot list,
// the log, debug logging, the status bar and the panel requests.
export class BridgeManager {
  readonly orca: OrcaWorkerApi
  readonly deps: BridgeDeps
  // The Orca bots on this computer, shared by every bridge.
  bots: BotSummary[] = []
  debugLogging = false

  private runtimes: BridgeRuntime[] = []
  private logs: BridgeLogEntry[] = []
  // Plugin-wide CLI calls (bot list, panel); a bridge traces its own calls into its own entries.
  private readonly cli: OrcaCliRunner
  private botsRefresh: Promise<void> | null = null
  private backgroundBotsRefresh: Promise<void> | null = null
  private bridgesWrite: Promise<void> = Promise.resolve()
  private globalOp: Promise<unknown> = Promise.resolve()
  private logFlushTimer: ReturnType<typeof setTimeout> | null = null
  // Newest first, across bridges; kept in memory and written in batches like the log.
  private audit: AuditEntry[] = []
  private auditFlushTimer: ReturnType<typeof setTimeout> | null = null
  private pluginKey: string | null = null
  // Tokens of removed bridges: an error raised by their last calls must not leak them either.
  private readonly formerTokens: string[] = []
  // Replaced voice API keys and those of removed bridges, redacted for the same reason.
  readonly formerVoiceKeys: string[] = []
  private readonly lastFailures = new Map<string, string>()
  private disposed = false
  // The last `workspace.list` answer (or the call still running) and when it was asked.
  private workspaceRows: { at: number; rows: Promise<{ id: string; kind: string; path: string }[]> } | null = null
  // Why the focused bot could not be found, each logged once: the panel asks on every focus change.
  private readonly focusProblems = new Set<string>()

  constructor(orca: OrcaWorkerApi, deps: BridgeDeps) {
    this.orca = orca
    this.deps = deps
    this.cli = traceOrcaCli(deps.orcaCli, {
      enabled: () => this.debugLogging,
      log: (level, scope, message, details) => this.appendLog(level, scope, message, details)
    })
  }

  get bridges(): readonly BridgeRuntime[] {
    return this.runtimes
  }

  bridge(bridgeId: string): BridgeRuntime {
    const runtime = this.runtimes.find((r) => r.id === bridgeId)
    if (!runtime) throw new Error(`No bridge with id "${bridgeId}".`)
    return runtime
  }

  async init(): Promise<void> {
    await this.loadDebugLogging()
    // Entries stored by 0.2.0 have no scope or details, and those before 0.5.0 no bridgeId.
    const savedLogs = await this.orca.storage.get(STORAGE_LOGS)
    this.logs = Array.isArray(savedLogs) ? (savedLogs as BridgeLogEntry[]).slice(0, MAX_LOGS) : []
    const savedAudit = await this.orca.storage.get(STORAGE_AUDIT)
    this.audit = this.pruneAudit(Array.isArray(savedAudit) ? (savedAudit as AuditEntry[]) : [])
    this.runtimes = (await this.loadBridges()).map((stored) => new BridgeRuntime(this, stored))
    for (const runtime of this.runtimes) await runtime.init()
    this.emitState()
    this.refreshBotsInBackground()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await Promise.all(this.runtimes.map((r) => r.dispose()))
    if (this.logFlushTimer) await this.flushLogs()
    if (this.auditFlushTimer) await this.flushAudit()
  }

  getState(): BridgeState {
    return toPlainJson({
      bridges: this.runtimes.map((r) => r.view()),
      bots: [...this.bots],
      global: { debugLogging: this.debugLogging },
      logs: this.logs.slice(0, STATE_LOGS),
      logTotal: this.logs.length
    })
  }

  private async loadDebugLogging(): Promise<void> {
    const value = await this.orca.settings.get('debugLogging')
    this.debugLogging = typeof value === 'boolean' ? value : false
  }

  // Only debug logging is a plugin setting; every other setting belongs to a bridge.
  reloadDebugLogging(): Promise<void> {
    return this.runGlobalOp(() => this.loadDebugLogging())
  }

  // Our own settings write fires onDidChange; running the reload after it keeps the write.
  private runGlobalOp<T>(op: () => Promise<T>): Promise<T> {
    const run = this.globalOp.then(op)
    this.globalOp = run.catch(() => {})
    return run
  }

  private async loadBridges(): Promise<StoredBridge[]> {
    const saved = await this.orca.storage.get(STORAGE_BRIDGES)
    if (!Array.isArray(saved)) return [await this.migrateLegacy()]
    // A migration that stopped after recording the bridge still has old keys to delete.
    if (typeof (await this.orca.storage.get(STORAGE_MIGRATION_ID)) === 'string') {
      await this.dropLegacy()
    }
    const bridges: StoredBridge[] = []
    for (const [i, raw] of saved.entries()) {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
      const id = raw.id
      if (typeof id !== 'string' || !id || bridges.some((b) => b.id === id)) continue
      bridges.push(readStoredBridge(raw, id, `Bridge ${i + 1}`))
    }
    return bridges
  }

  // 0.4.0 kept its one bridge in plugin settings, the secret `botToken` and `tg.*` keys. They are
  // copied to "Bridge 1" and read back; only then is the bridge recorded and the old keys deleted.
  private async migrateLegacy(): Promise<StoredBridge> {
    const pending = await this.orca.storage.get(STORAGE_MIGRATION_ID)
    const id = typeof pending === 'string' && pending ? pending : newBridgeId(new Set())
    await this.orca.storage.set(STORAGE_MIGRATION_ID, id)

    const settings = await this.orca.settings.get()
    const token = (await this.orca.secrets.get(LEGACY_SECRET_BOT_TOKEN))?.trim() || null
    const stored = readStoredBridge(
      {
        ...settings,
        name: 'Bridge 1',
        orcaBot: settings.defaultBot,
        // A paused bot stays paused; without a token there is nothing to switch on.
        enabled: token !== null && settings.enabled !== false
      },
      id,
      'Bridge 1'
    )

    if (token) await this.orca.secrets.set(bridgeSecretKey(id), token)
    const copied = new Map<BridgeStorageName, string>()
    for (const name of BRIDGE_STORAGE_NAMES) {
      const legacyKey = LEGACY_STORAGE[name]
      if (!legacyKey) continue
      const value = await this.orca.storage.get(legacyKey)
      if (value === null) continue
      await this.orca.storage.set(bridgeStorageKey(id, name), value)
      copied.set(name, JSON.stringify(value))
    }
    if (token && (await this.orca.secrets.get(bridgeSecretKey(id)))?.trim() !== token) {
      throw new Error('Moving the bot token into Bridge 1 failed: the stored copy does not match.')
    }
    for (const [name, json] of copied) {
      if (JSON.stringify(await this.orca.storage.get(bridgeStorageKey(id, name))) !== json) {
        throw new Error(`Moving ${LEGACY_STORAGE[name]} into Bridge 1 failed: the stored copy does not match.`)
      }
    }

    await this.orca.storage.set(STORAGE_BRIDGES, toPlainJson([stored]))
    await this.dropLegacy()
    await this.appendLog(
      'info',
      'config',
      token ? 'Moved the Telegram bridge settings into "Bridge 1".' : 'Created "Bridge 1".',
      undefined,
      id
    )
    return stored
  }

  private async dropLegacy(): Promise<void> {
    await this.orca.secrets.delete(LEGACY_SECRET_BOT_TOKEN)
    for (const name of BRIDGE_STORAGE_NAMES) {
      const legacyKey = LEGACY_STORAGE[name]
      if (legacyKey) await this.orca.storage.delete(legacyKey)
    }
    await this.orca.storage.delete(STORAGE_MIGRATION_ID)
  }

  // Writes the list as it is when the write runs; writes run one after another, so the last one wins.
  saveBridges(): Promise<void> {
    const run = this.bridgesWrite.then(() =>
      this.orca.storage.set(STORAGE_BRIDGES, toPlainJson(this.runtimes.map((r) => r.stored())))
    )
    this.bridgesWrite = run.catch(() => {})
    return run
  }

  // One bridge per Orca bot: the panel shows a bot's one bridge, so a second one would be hidden.
  // '' (the first Orca bot found) is not a name and never conflicts.
  private bridgeOfBot(orcaBot: string, except?: BridgeRuntime): BridgeRuntime | undefined {
    const name = orcaBot.trim()
    return name ? this.runtimes.find((r) => r !== except && r.orcaBot === name) : undefined
  }

  private async refuseSecondBridge(orcaBot: string, owner: BridgeRuntime, bridgeId?: string): Promise<never> {
    const name = orcaBot.trim()
    await this.appendLog('warn', 'config', `Refused a second bridge for the Orca bot "${name}".`, undefined, bridgeId)
    throw new Error(`The Orca bot "${name}" already has a Telegram bridge ("${owner.name}"). Each Orca bot gets one bridge.`)
  }

  async addBridge(name?: string, orcaBot = ''): Promise<string> {
    const owner = this.bridgeOfBot(orcaBot)
    if (owner) await this.refuseSecondBridge(orcaBot, owner)
    const id = newBridgeId(new Set(this.runtimes.map((r) => r.id)))
    const names = new Set(this.runtimes.map((r) => r.name))
    let n = this.runtimes.length + 1
    while (names.has(`Bridge ${n}`)) n++
    // A new bridge stays out of groups until the owner allows them.
    // Given roles, a new bridge is not taken for one stored before roles: nothing to review.
    const runtime = new BridgeRuntime(
      this,
      readStoredBridge({ name, orcaBot, allowGroups: false, roles: defaultRoles() }, id, `Bridge ${n}`)
    )
    this.runtimes.push(runtime)
    await this.saveBridges()
    await runtime.init()
    await this.appendLog('info', 'config', `Added bridge "${runtime.name}".`, undefined, id)
    await this.recordAudit({ bridgeId: id, source: 'panel', action: 'bridgeAdded', target: runtime.name, result: 'done' })
    this.emitState()
    return id
  }

  // Stops the bridge, then forgets it: its token and its stored state. Its log entries stay.
  async removeBridge(bridgeId: string): Promise<void> {
    const runtime = this.bridge(bridgeId)
    await runtime.runConfigOp(() => runtime.dispose())
    this.formerTokens.push(...runtime.tokens())
    this.formerVoiceKeys.push(...runtime.voiceKeys())
    this.runtimes = this.runtimes.filter((r) => r !== runtime)
    await this.saveBridges()
    await this.orca.secrets.delete(bridgeSecretKey(bridgeId))
    await this.orca.secrets.delete(voiceSecretKey(bridgeId))
    for (const name of BRIDGE_STORAGE_NAMES) {
      await this.orca.storage.delete(bridgeStorageKey(bridgeId, name))
    }
    await this.appendLog('info', 'config', `Removed bridge "${runtime.name}".`, undefined, bridgeId)
    await this.recordAudit({ bridgeId, source: 'panel', action: 'bridgeRemoved', target: runtime.name, result: 'done' })
    this.emitState()
  }

  // Telegram lets one poller per token; two bridges on one token would steal each other's updates.
  // Bridges that shared an Orca bot before the one-bridge-per-bot rule keep saving while their bot
  // stays the same; only moving a bridge onto a bot another bridge has is refused.
  async saveConfig(input: SaveConfigInput): Promise<void> {
    const runtime = this.bridge(input.bridgeId)
    const botOwner = input.orcaBot.trim() !== runtime.orcaBot ? this.bridgeOfBot(input.orcaBot, runtime) : undefined
    if (botOwner) await this.refuseSecondBridge(input.orcaBot, botOwner, runtime.id)
    const token = input.clearToken ? '' : (input.botToken ?? '').trim()
    const owner = token ? this.runtimes.find((r) => r !== runtime && r.usesToken(token)) : undefined
    if (owner) {
      await this.appendLog('warn', 'config', `Refused a bot token that bridge "${owner.name}" already uses.`, undefined, runtime.id)
      throw new Error(`This bot token is already used by the bridge "${owner.name}". Each bridge needs its own Telegram bot.`)
    }
    await runtime.saveConfig(input)
  }

  // The palette command: pauses every running bridge, or else starts every bridge that has a token.
  async togglePolling(): Promise<string> {
    const running = this.runtimes.filter((r) => r.active)
    if (running.length > 0) {
      await Promise.all(running.map((r) => r.setEnabled(false)))
      return `Telegram Bridge: paused ${running.length} bridge(s)`
    }
    const ready = this.runtimes.filter((r) => r.hasToken)
    if (ready.length === 0) return 'Telegram Bridge: add a bot token to a bridge in the Telegram panel first'
    await Promise.all(ready.map((r) => r.setEnabled(true)))
    return `Telegram Bridge: started ${ready.length} bridge(s)`
  }

  // The palette command: tests every bridge that has a token, side by side.
  async testAll(): Promise<string> {
    const ready = this.runtimes.filter((r) => r.hasToken)
    if (ready.length === 0) return 'No bridge has a Telegram bot token yet.'
    const lines = await Promise.all(
      ready.map(async (r) => {
        const res = await r.testConnection()
        return `${r.name}: ${res.ok ? `connected as @${res.username || res.botId}` : `failed: ${res.error}`}`
      })
    )
    return lines.join('; ')
  }

  // Shows this plugin's panel in Orca's right sidebar (the status bar item runs this).
  async openPanel(): Promise<string> {
    const key = await this.resolvePluginKey()
    if (!key) {
      const message = 'Cannot open the Telegram panel: the plugin manifest is not readable.'
      await this.appendLog('warn', 'orca-cli', message)
      return message
    }
    try {
      await this.cli.openPanel(key, PANEL_ID)
      return 'Telegram panel opened'
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err)
      const message = /no_workspace/.test(raw) ? `${raw} (Open a workspace in Orca first)` : raw
      await this.appendLog('warn', 'orca-cli', `Failed to open the Telegram panel: ${message}`, describeError(err))
      return message
    }
  }

  // A copy installed with `orca plugin dev` has its own key, so the manifest's `<publisher>.<id>`
  // could open another copy. Asked once; the manifest key while the CLI cannot tell.
  private async resolvePluginKey(): Promise<string | null> {
    if (this.pluginKey) return this.pluginKey
    const info = await readPluginInfo()
    if (!info.id) return info.key
    try {
      this.pluginKey = pickPluginKey(await this.cli.listPlugins(), info.id) ?? info.key
      return this.pluginKey
    } catch (err) {
      await this.appendLog('debug', 'orca-cli', 'Listing plugins failed; opening the panel by the manifest key', describeError(err))
      return info.key
    }
  }

  async clearLogs(): Promise<void> {
    this.logs = []
    await this.orca.storage.set(STORAGE_LOGS, [])
    this.emitState()
  }

  setDebugLogging(enabled: boolean): Promise<void> {
    return this.runGlobalOp(async () => {
      await this.orca.settings.set('debugLogging', enabled)
      this.debugLogging = enabled
      await this.appendLog('info', 'config', enabled ? 'Debug logging enabled' : 'Debug logging disabled')
      this.emitState()
    })
  }

  async exportLogs(): Promise<ExportLogsResult> {
    const now = new Date()
    const plugin = await readPluginInfo()
    const names = new Map(this.runtimes.map((r) => [r.id, r.name]))
    const lines = [
      'Telegram Bridge diagnostics',
      `Plugin: ${plugin.name} ${plugin.version}`,
      `Exported: ${now.toISOString()}`,
      `Platform: ${process.platform} ${process.arch}`,
      `Node: ${process.version}`,
      `Orca CLI: ${getOrcaBinary()}`,
      `Debug logging: ${this.debugLogging ? 'on' : 'off'}`,
      `Orca bots: ${this.bots.length}`,
      `Bridges: ${this.runtimes.length}`,
      ...this.runtimes.flatMap((r) => r.exportLines()),
      `Log entries: ${this.logs.length}`,
      ''
    ]
    for (const entry of [...this.logs].reverse()) {
      const bridge = entry.bridgeId ? ` [${names.get(entry.bridgeId) ?? entry.bridgeId}]` : ''
      lines.push(
        `${new Date(entry.at).toISOString()} ${entry.level.toUpperCase()} [${entry.scope ?? '-'}]${bridge} ${entry.message}`
      )
      if (entry.details) lines.push(indentLines(entry.details))
    }
    return {
      fileName: `telegram-bridge-logs-${fileTimestamp(now)}.txt`,
      text: this.redact(`${lines.join('\n')}\n`)
    }
  }

  // Newest first, at most AUDIT_PAGE, with how many match in all.
  listAudit(query: AuditQuery): { entries: AuditEntry[]; total: number } {
    const matching = this.auditMatching(query)
    return toPlainJson({ entries: matching.slice(0, AUDIT_PAGE), total: matching.length })
  }

  // Every matching entry, newest first, every field quoted; a removed bridge shows by its id.
  exportAudit(query: AuditQuery): ExportLogsResult {
    const names = new Map(this.runtimes.map((r) => [r.id, r.name]))
    const rows = [
      ['time', 'bridge', 'source', 'user id', 'user', 'chat', 'role', 'action', 'target', 'result'],
      ...this.auditMatching(query).map((e) => [
        new Date(e.at).toISOString(),
        names.get(e.bridgeId) ?? e.bridgeId,
        e.source,
        e.userId ?? '',
        e.userLabel ?? '',
        e.chatId ?? '',
        e.roleName ?? '',
        e.action,
        e.target ?? '',
        e.result
      ])
    ]
    return {
      fileName: `telegram-bridge-audit-${fileTimestamp(new Date(this.now()))}.csv`,
      text: `${rows.map((row) => row.map((field) => `"${field.replaceAll('"', '""')}"`).join(',')).join('\n')}\n`
    }
  }

  private auditMatching(query: AuditQuery): AuditEntry[] {
    return this.pruneAudit(this.audit).filter(
      (e) =>
        (!query.bridgeId || e.bridgeId === query.bridgeId) &&
        (!query.action || e.action === query.action) &&
        (!query.result || e.result === query.result)
    )
  }

  // One shared `orca bot list` call for every caller of every bridge: sync ticks, messages, panel loads.
  refreshBots(): Promise<void> {
    if (!this.botsRefresh) {
      this.botsRefresh = this.loadBots().finally(() => {
        this.botsRefresh = null
      })
    }
    return this.botsRefresh
  }

  private async loadBots(): Promise<void> {
    try {
      this.bots = await this.cli.listBots()
      this.lastFailures.delete('listBots')
    } catch (err) {
      // Refreshed by every message, sync tick and panel load; log a failure again only when it changes.
      if (isRepeatedFailure(this.lastFailures, 'listBots', err)) return
      const msg = err instanceof Error ? err.message : String(err)
      await this.appendLog('warn', 'orca-cli', `Failed to list Orca bots: ${msg}`, describeError(err))
    }
  }

  // The Orca bot selected in Orca's sidebar: Orca focuses a bot's home, the folder workspace that
  // holds its bot.json. The worker asks for the focus itself, so the id it matches against
  // `workspace.list` is in the same form as the rows' ids (a panel frame may see another form).
  async focusedBot(): Promise<FocusedBot> {
    let workspaceId: string | undefined
    try {
      const context = await this.orca.host.call('workspace.readContext')
      if (!context) return { kind: 'none' }
      workspaceId = context.workspaceId
    } catch (err) {
      return this.focusUnknown('Orca did not tell which workspace is focused.', err)
    }
    if (!workspaceId) return this.focusUnknown('This Orca does not name the focused workspace.')
    let rows: { id: string; kind: string; path: string }[]
    try {
      rows = await this.listWorkspaces()
    } catch (err) {
      return this.focusUnknown('Listing Orca workspaces failed.', err)
    }
    const row = rows.find((r) => r.id === workspaceId)
    // An unlisted id means the two could not be matched, not that the focus is no bot.
    if (!row) return this.focusUnknown('The focused workspace is not in Orca\'s workspace list.')
    if (row.kind !== 'folder') return { kind: 'none' }
    const file = path.join(row.path, 'bot.json')
    let raw: string
    try {
      raw = await fs.readFile(file, 'utf8')
    } catch (err) {
      // A project folder has no bot.json: that only means it is not a bot.
      const code = (err as NodeJS.ErrnoException | undefined)?.code
      if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'none' }
      return this.focusUnknown('Reading the focused folder\'s bot.json failed.', err)
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null) {
        const { id, name } = parsed as { id?: unknown; name?: unknown }
        if (typeof id === 'string' && id.trim() && typeof name === 'string' && name.trim()) {
          return { kind: 'bot', bot: { id: id.trim(), name: name.trim() } }
        }
      }
    } catch {
      // Logged below with the other files that are no bot.json.
    }
    await this.appendLog('debug', 'bridge', `${file} has no string id and name; not treated as an Orca bot`)
    return { kind: 'none' }
  }

  private async focusUnknown(reason: string, err?: unknown): Promise<FocusedBot> {
    if (!this.focusProblems.has(reason)) {
      this.focusProblems.add(reason)
      await this.appendLog(
        'warn',
        'bridge',
        `Cannot tell which Orca bot is selected; the panel shows every bridge. ${reason}`,
        err === undefined ? undefined : describeError(err)
      )
    }
    return { kind: 'unknown', reason }
  }

  private listWorkspaces(): Promise<{ id: string; kind: string; path: string }[]> {
    const now = Date.now()
    if (this.workspaceRows && now - this.workspaceRows.at < WORKSPACE_LIST_CACHE_MS) {
      return this.workspaceRows.rows
    }
    const entry = {
      at: now,
      rows: this.orca.host.call('workspace.list').then((res) => res.workspaces)
    }
    this.workspaceRows = entry
    // A failed list is not kept: the next focus change asks Orca again.
    entry.rows.catch(() => {
      if (this.workspaceRows === entry) this.workspaceRows = null
    })
    return entry.rows
  }

  // `orca bot list` can hang for the full CLI timeout (30s), longer than the host's 10s
  // ready deadline. Startup and panel loads must not wait for it; message handling
  // refreshes bots itself. One shared call so repeated panel opens do not pile up CLI processes.
  refreshBotsInBackground(): void {
    if (this.backgroundBotsRefresh) return
    this.backgroundBotsRefresh = this.refreshBots().finally(() => {
      this.backgroundBotsRefresh = null
      if (!this.disposed) this.emitState()
    })
  }

  // Debug entries are stored only while debugLogging is on and never post state themselves.
  async appendLog(
    level: BridgeLogEntry['level'],
    scope: LogScope,
    message: string,
    details?: string,
    bridgeId?: string
  ): Promise<void> {
    if (level === 'debug' && !this.debugLogging) return
    const at = Date.now()
    const entry: BridgeLogEntry = {
      id: `${at}-${Math.random().toString(36).slice(2, 7)}`,
      at,
      level,
      scope,
      ...(bridgeId ? { bridgeId } : {}),
      message: truncateText(this.redact(message), MAX_DETAIL_CHARS),
      ...(details ? { details: truncateText(this.redact(details), MAX_LOG_DETAILS_CHARS) } : {})
    }
    this.logs = [entry, ...this.logs].slice(0, MAX_LOGS)
    const bridgeName = bridgeId ? this.runtimes.find((r) => r.id === bridgeId)?.name ?? bridgeId : null
    this.orca.log(`[${level}] [${scope}]${bridgeName ? ` [${bridgeName}]` : ''} ${entry.message}`)
    // Writing the whole ring per line is too much; batch the writes, orca.log above stays immediate.
    const flushMs = this.deps.logFlushMs ?? LOG_FLUSH_MS
    if (flushMs <= 0) {
      await this.flushLogs()
    } else if (!this.logFlushTimer) {
      const timer = setTimeout(() => {
        this.logFlushTimer = null
        void this.flushLogs()
      }, flushMs)
      // A pending write must not keep the worker process alive; dispose flushes it.
      if (typeof timer === 'object' && 'unref' in timer) timer.unref()
      this.logFlushTimer = timer
    }
  }

  private async flushLogs(): Promise<void> {
    if (this.logFlushTimer) {
      clearTimeout(this.logFlushTimer)
      this.logFlushTimer = null
    }
    try {
      await this.orca.storage.set(STORAGE_LOGS, this.logs)
    } catch (err) {
      // Not through appendLog: that would schedule another write to the failing store.
      const message = err instanceof Error ? err.message : String(err)
      this.orca.log(`[warn] [bridge] Storing logs failed: ${this.redact(message)}`)
    }
  }

  // Every audit entry goes through here. Entries are written in batches like the log, and flushed
  // on dispose.
  async recordAudit(fields: Omit<AuditEntry, 'id' | 'at'>): Promise<void> {
    const at = this.now()
    const entry: AuditEntry = { id: `${at}-${Math.random().toString(36).slice(2, 7)}`, at, ...fields }
    this.audit = this.pruneAudit([entry, ...this.audit])
    const flushMs = this.deps.logFlushMs ?? LOG_FLUSH_MS
    if (flushMs <= 0) {
      await this.flushAudit()
    } else if (!this.auditFlushTimer) {
      const timer = setTimeout(() => {
        this.auditFlushTimer = null
        void this.flushAudit()
      }, flushMs)
      if (typeof timer === 'object' && 'unref' in timer) timer.unref()
      this.auditFlushTimer = timer
    }
  }

  // Newest first; at most 90 days old and MAX_AUDIT entries.
  private pruneAudit(entries: AuditEntry[]): AuditEntry[] {
    const since = this.now() - AUDIT_KEEP_MS
    return entries
      .filter((e) => e.at >= since)
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_AUDIT)
  }

  private async flushAudit(): Promise<void> {
    if (this.auditFlushTimer) {
      clearTimeout(this.auditFlushTimer)
      this.auditFlushTimer = null
    }
    try {
      await this.orca.storage.set(STORAGE_AUDIT, toPlainJson(this.audit))
    } catch (err) {
      // Not through appendLog, whose write may fail the same way.
      const message = err instanceof Error ? err.message : String(err)
      this.orca.log(`[warn] [bridge] Storing the audit trail failed: ${this.redact(message)}`)
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  // No bot token or voice API key of any bridge may reach a log line, a detail, a Telegram reply or
  // an export.
  redact(text: string): string {
    let out = text.replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot<redacted>')
    for (const token of [...this.runtimes.flatMap((r) => r.tokens()), ...this.formerTokens]) {
      out = out.split(token).join('bot<redacted>')
    }
    for (const key of [...this.runtimes.flatMap((r) => r.voiceKeys()), ...this.formerVoiceKeys]) {
      out = out.split(key).join('<redacted>')
    }
    return out
  }

  emitState(): void {
    this.orca.panels.post('bridge.stateChanged', this.getState())
    void this.syncStatusBar()
  }

  // One item for every bridge: connected / active, toned by the worst active bridge.
  private async syncStatusBar(): Promise<void> {
    const active = this.runtimes.filter((r) => r.active)
    const connected = active.filter((r) => r.connectionStatus === 'connected').length
    let text: string
    let tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'
    if (!this.runtimes.some((r) => r.hasToken)) {
      text = 'TG: Setup'
      tone = 'warning'
    } else if (active.length === 0) {
      text = 'TG: Off'
      tone = 'neutral'
    } else {
      text = `TG: ${connected}/${active.length}`
      tone = active.some((r) => r.connectionStatus === 'error')
        ? 'danger'
        : connected === active.length
          ? 'success'
          : 'accent'
    }
    const tooltip = [
      'Telegram Bridge',
      ...this.runtimes.map((r) => `${r.name}${r.username ? ` (@${r.username})` : ''}: ${r.connectionStatus}`),
      '(click to open the panel)'
    ].join('\n')

    try {
      await this.orca.host.call('statusBar.update', { id: STATUS_BAR_ID, text, tone, tooltip })
      this.lastFailures.delete('statusBar')
    } catch (err) {
      // Test hosts may not register statusBarItems; emitted on every state change, so logged once.
      if (!isRepeatedFailure(this.lastFailures, 'statusBar', err)) {
        await this.appendLog('debug', 'bridge', 'Updating the status bar failed', describeError(err))
      }
    }
  }
}

let activeManager: BridgeManager | null = null

export async function activateWithDeps(orca: OrcaWorkerApi, deps: BridgeDeps): Promise<BridgeManager> {
  const manager = new BridgeManager(orca, deps)
  activeManager = manager
  const state = () => manager.getState()

  orca.panels.handle('bridge.getState', async () => {
    await manager.reloadDebugLogging()
    manager.refreshBotsInBackground()
    return state()
  })
  orca.panels.handle('bridge.add', async (input) => {
    const bridgeId = await manager.addBridge(input?.name, input?.orcaBot)
    return { bridgeId, state: state() }
  })
  orca.panels.handle('bridge.remove', async ({ bridgeId }) => {
    await manager.removeBridge(bridgeId)
    return state()
  })
  orca.panels.handle('bridge.saveConfig', async (input) => {
    await manager.saveConfig(input)
    return state()
  })
  orca.panels.handle('bridge.testConnection', async ({ bridgeId }) => {
    const result = await manager.bridge(bridgeId).testConnection()
    return { ...result, state: state() }
  })
  orca.panels.handle('bridge.setEnabled', async ({ bridgeId, enabled }) => {
    await manager.bridge(bridgeId).setEnabled(Boolean(enabled))
    return state()
  })
  orca.panels.handle('bridge.allowUserId', async ({ bridgeId, userId }) => {
    await manager.bridge(bridgeId).allowUserId(userId)
    return state()
  })
  orca.panels.handle('bridge.resetBinding', async ({ bridgeId, tgChatId }) => {
    await manager.bridge(bridgeId).resetBinding(tgChatId)
    return state()
  })
  orca.panels.handle('bridge.clearLogs', async () => {
    await manager.clearLogs()
    return state()
  })
  orca.panels.handle('bridge.setDebugLogging', async ({ enabled }) => {
    await manager.setDebugLogging(Boolean(enabled))
    return state()
  })
  orca.panels.handle('bridge.exportLogs', () => manager.exportLogs())
  orca.panels.handle('bridge.listAudit', (query) => manager.listAudit(query ?? {}))
  orca.panels.handle('bridge.exportAudit', (query) => manager.exportAudit(query ?? {}))
  orca.panels.handle('bridge.focusedBot', () => manager.focusedBot())
  // For a role's "may run only these" list in the panel: ids and names only.
  orca.panels.handle('bridge.listAutomations', async () =>
    toPlainJson((await deps.orcaCli.listAutomations()).map((a) => ({ id: a.id, name: a.name })))
  )

  orca.commands.register('telegram-bridge.togglePolling', () => manager.togglePolling())
  orca.commands.register('telegram-bridge.openPanel', () => manager.openPanel())
  orca.commands.register('telegram-bridge.testConnection', () => manager.testAll())

  orca.settings.onDidChange(() => {
    void manager.reloadDebugLogging()
  })

  await manager.init()
  return manager
}

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  await activateWithDeps(orca, {
    telegram: createTelegramClient(),
    orcaCli: createOrcaCliRunner()
  })
}

export async function deactivate(): Promise<void> {
  if (activeManager) {
    await activeManager.dispose()
    activeManager = null
  }
}
