import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setImmediate as nextTurn, setTimeout as pause } from 'node:timers/promises'
import { assert, hostError, mockHost, mountWorker, test, type MockHost, type TestWorker } from 'orca/testing'
import type { JsonValue } from 'orca'
import type { OrcaWorkerApi } from 'orca/worker'
import { t } from './i18n'
import {
  computeTailHashes,
  DispatchTimeoutError,
  extractMessageItems,
  findUnsyncedTail,
  isTelegramOriginatedUserMessage,
  OrcaCliError,
  type OrcaChatSummary,
  type OrcaCliRunner,
  type OrcaSessionRead
} from './orca-bridge'
import type { AuditEntry, BridgeLogEntry, BridgeState, ExportLogsResult, SaveConfigInput } from './protocol'
import { defaultRoles, type BridgeRole } from './roles'
import { extractTablesFromMarkdown } from './table-render'
import {
  markdownToTelegramHtml,
  splitTelegramMessage,
  TelegramApiError,
  type TelegramBotCommand,
  type TelegramClient,
  type TelegramDocument,
  type TelegramInlineKeyboardMarkup,
  type TelegramMessage,
  type TelegramUpdate
} from './telegram-api'
import * as main from './worker'
import type { BridgeDeps, BridgeManager, BridgeRuntime } from './worker'
import type { TranscribeParams } from './transcribe'

function makeMockDeps(overrides: Partial<{ telegram: Partial<TelegramClient>; orcaCli: Partial<OrcaCliRunner> }> = {}) {
  const sentMessages: {
    token: string
    chatId: number | string
    text: string
    replyToMessageId?: number
    parseMode?: string
    replyMarkup?: TelegramInlineKeyboardMarkup
  }[] = []
  const sentPhotos: {
    chatId: number | string
    bytes: number
    url?: string
    filename?: string
    contentType?: string
    caption?: string
    replyToMessageId?: number
  }[] = []
  const sentDocuments: {
    chatId: number | string
    bytes: number
    url?: string
    filename?: string
    contentType?: string
    caption?: string
    replyToMessageId?: number
  }[] = []
  // Every message, photo and document in the order the bridge sent them.
  const outbox: string[] = []
  const sentActions: { chatId: number | string; action: string }[] = []
  const answeredCallbacks: { callbackQueryId: string; text?: string; showAlert?: boolean }[] = []
  // Default-scope menus only: default language (what most tests count), and every menu with its
  // language in registeredMenus. Per-chat menus are in chatMenus, removed ones in deletedChatMenus.
  const registeredCommands: TelegramBotCommand[][] = []
  const registeredMenus: { languageCode: string | null; commands: TelegramBotCommand[] }[] = []
  const chatMenus: { chatId: number | string; languageCode: string | null; commands: TelegramBotCommand[] }[] = []
  const deletedChatMenus: { chatId: number | string; languageCode: string | null }[] = []
  const sentToBots: { botName: string; chatId: string; subject: string; body: string }[] = []
  const renamedChats: { sessionId: string; name: string }[] = []
  const triggeredAutomations: string[] = []
  const openedPanels: { pluginKey: string; panelId: string }[] = []
  const leftChats: (number | string)[] = []
  const editedMessages: { chatId: number | string; messageId: number; text: string }[] = []
  const deletedMessages: { chatId: number | string; messageId: number }[] = []
  // Every getChat id, in order.
  const chatLookups: (number | string)[] = []

  let chats: OrcaChatSummary[] = [
    {
      id: 'home-chat-1',
      title: 'Home',
      lastActivityAt: 1000,
      lastAsked: null,
      lastSaid: null,
      home: true,
      self: true,
      closed: false
    }
  ]

  const sessions = new Map<string, OrcaSessionRead>()
  let readPollCount = 0

  const telegram: TelegramClient = {
    async getMe() {
      return { id: 100000001, is_bot: true, first_name: 'DemoBot', username: 'demo_orca_bot' }
    },
    async setMyCommands(_token, commands, _options, languageCode, scope) {
      if (scope) {
        chatMenus.push({ chatId: scope.chat_id, languageCode: languageCode ?? null, commands })
        return true
      }
      registeredMenus.push({ languageCode: languageCode ?? null, commands })
      if (!languageCode) registeredCommands.push(commands)
      return true
    },
    async deleteMyCommands(_token, _options, scope, languageCode) {
      if (scope) deletedChatMenus.push({ chatId: scope.chat_id, languageCode: languageCode ?? null })
      return true
    },
    async getUpdates() {
      return []
    },
    async sendMessage(token, params) {
      outbox.push(`message:${params.text}`)
      sentMessages.push({
        token,
        chatId: params.chatId,
        text: params.text,
        replyToMessageId: params.replyToMessageId,
        parseMode: params.parseMode,
        replyMarkup: params.replyMarkup
      })
      return {
        message_id: 900 + sentMessages.length,
        chat: { id: Number(params.chatId), type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: params.text
      }
    },
    async answerCallbackQuery(_token, params) {
      answeredCallbacks.push({
        callbackQueryId: params.callbackQueryId,
        text: params.text,
        showAlert: params.showAlert
      })
      return true
    },
    async sendPhoto(_token, params) {
      outbox.push(`photo:${params.filename ?? ''}`)
      sentPhotos.push({
        chatId: params.chatId,
        bytes: typeof params.photo === 'string' ? 0 : params.photo.length,
        url: typeof params.photo === 'string' ? params.photo : undefined,
        filename: params.filename,
        contentType: params.contentType,
        caption: params.caption,
        replyToMessageId: params.replyToMessageId
      })
      return {
        message_id: 950 + sentPhotos.length,
        chat: { id: Number(params.chatId), type: 'private' },
        date: Math.floor(Date.now() / 1000)
      }
    },
    async sendDocument(_token, params) {
      outbox.push(`document:${params.filename ?? ''}`)
      sentDocuments.push({
        chatId: params.chatId,
        bytes: typeof params.document === 'string' ? 0 : params.document.length,
        url: typeof params.document === 'string' ? params.document : undefined,
        filename: params.filename,
        contentType: params.contentType,
        caption: params.caption,
        replyToMessageId: params.replyToMessageId
      })
      return {
        message_id: 970 + sentDocuments.length,
        chat: { id: Number(params.chatId), type: 'private' },
        date: Math.floor(Date.now() / 1000)
      }
    },
    async sendChatAction(_token, params) {
      sentActions.push({ chatId: params.chatId, action: params.action })
      return true
    },
    async getFile(_token, fileId) {
      return {
        file_id: fileId,
        file_unique_id: `u_${fileId}`,
        file_size: 16,
        file_path: fileId.includes('png') ? 'documents/file_1.png' : 'photos/file_0.jpg'
      }
    },
    async downloadFile() {
      return Buffer.from('fake-image-bytes')
    },
    async leaveChat(_token, chatId) {
      leftChats.push(chatId)
      return true
    },
    // Telegram knows no chat with these test ids, as for a person who never opened the bot.
    async getChat(_token, chatId) {
      chatLookups.push(chatId)
      throw new TelegramApiError('Bad Request: chat not found', 400)
    },
    async editMessageText(_token, params) {
      outbox.push(`edit:${params.messageId}:${params.text}`)
      editedMessages.push({ chatId: params.chatId, messageId: params.messageId, text: params.text })
      return {
        message_id: params.messageId,
        chat: { id: Number(params.chatId), type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: params.text
      }
    },
    async deleteMessage(_token, chatId, messageId) {
      outbox.push(`delete:${messageId}`)
      deletedMessages.push({ chatId, messageId })
      return true
    },
    ...overrides.telegram
  }

  const orcaCli: OrcaCliRunner = {
    async listBots() {
      return [
        { id: 'bot-1', name: 'Assistant', specialty: 'Workspace assistant', agent: 'claude' },
        { id: 'bot-2', name: 'Daily standup notes', specialty: 'Standup summary', agent: 'claude' }
      ]
    },
    async listBotChats() {
      return [...chats]
    },
    async readSession(sessionId) {
      readPollCount++
      const s = sessions.get(sessionId)
      if (!s) {
        return { orcaSessionId: sessionId, state: 'done', entries: [] }
      }
      if (s.state === 'working' && readPollCount >= 2) {
        s.state = 'done'
      }
      return { ...s, entries: [...s.entries] }
    },
    async renameChat(sessionId, name) {
      renamedChats.push({ sessionId, name })
      chats = chats.map((c) => (c.id === sessionId ? { ...c, title: name } : c))
    },
    async listAutomations() {
      return [
        {
          id: 'auto-1',
          name: 'Daily backup',
          enabled: true,
          lastRunStatus: 'completed'
        }
      ]
    },
    async runAutomation(id) {
      triggeredAutomations.push(id)
    },
    async listAutomationRuns() {
      return []
    },
    async openPanel(pluginKey, panelId) {
      openedPanels.push({ pluginKey, panelId })
    },
    async listPlugins() {
      return []
    },
    async sendToBot({ botName, chatId, subject, body }) {
      sentToBots.push({ botName, chatId, subject, body })
      readPollCount = 0
      let targetId = chatId
      if (chatId === 'new') {
        targetId = `tg-chat-${chats.length + 1}`
        chats = [
          {
            id: targetId,
            title: subject,
            lastActivityAt: Date.now(),
            lastAsked: body,
            lastSaid: null,
            home: false,
            self: false,
            closed: false
          },
          ...chats
        ]
      }
      const existing = sessions.get(targetId) ?? {
        orcaSessionId: targetId,
        state: 'done',
        entries: []
      }
      const replyNum = existing.entries.filter((e) => e.role === 'assistant').length + 1
      existing.entries.push({ kind: 'message', role: 'user', text: body })
      existing.entries.push({
        kind: 'message',
        role: 'assistant',
        text: `Reply #${replyNum} from ${botName}`
      })
      existing.state = 'working'
      sessions.set(targetId, existing)
    },
    ...overrides.orcaCli
  }

  return {
    telegram,
    orcaCli,
    sentMessages,
    sentPhotos,
    sentDocuments,
    outbox,
    sentActions,
    answeredCallbacks,
    registeredCommands,
    registeredMenus,
    chatMenus,
    deletedChatMenus,
    sentToBots,
    renamedChats,
    triggeredAutomations,
    openedPanels,
    leftChats,
    editedMessages,
    deletedMessages,
    chatLookups
  }
}

const CAPABILITIES = ['storage:own', 'secrets:own', 'settings:own', 'notifications:show']

// Activates through the real entry point, so the panel handlers are wired. Most hosts here hold the
// 0.4.0 layout (plugin settings and the secret `botToken`); activation moves it into "Bridge 1" as
// a real update does, and `controller` is that bridge.
async function mountController(host: MockHost, deps: BridgeDeps) {
  let manager!: BridgeManager
  const worker = await mountWorker(
    {
      default: async (orca: OrcaWorkerApi) => {
        manager = await main.activateWithDeps(orca, deps)
      },
      deactivate: main.deactivate
    },
    { host }
  )
  return { manager, controller: manager.bridges[0], worker }
}

// The panel always sends every field of the bridge form; unchanged fields keep the bridge's values.
// A test that sets only the list gets the mode the panel would show for it: restricted when it lists an ID.
function saveInput(bridge: BridgeRuntime, fields: Partial<SaveConfigInput>): SaveConfigInput {
  const { config } = bridge.view()
  const restricted =
    fields.allowedUserIds === undefined
      ? config.restricted
      : fields.allowedUserIds.split(/[\s,;]+/).some((id) => /^-?\d+$/.test(id))
  return {
    bridgeId: bridge.id,
    name: config.name,
    orcaBot: config.orcaBot,
    restricted,
    allowedUserIds: config.allowedUserIds,
    proxyUrl: config.proxyUrl,
    replyTimeoutSec: config.replyTimeoutSec,
    syncOrcaOutbound: config.syncOrcaOutbound,
    ...fields
  }
}

// A regression that deadlocks fails the test instead of hanging it (the same guard as the activation test).
async function within<T>(promise: Promise<T>, label: string, ms = 2000): Promise<T> {
  const timeout = Promise.withResolvers<never>()
  const timer = setTimeout(() => timeout.reject(new Error(`Timed out waiting for ${label}`)), ms)
  try {
    return await Promise.race([promise, timeout.promise])
  } finally {
    clearTimeout(timer)
  }
}

// Yields whole event-loop turns (no clock wait) so in-memory host calls settle between checks.
async function until(ready: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (ready()) return
    await nextTurn()
  }
  throw new Error(`Gave up waiting for ${label}`)
}

// Returns each batch once, then long-polls until the poll loop aborts, like Telegram with no new updates.
function scriptedGetUpdates(
  batches: TelegramUpdate[][],
  onPoll?: (token: string, offset: number | undefined) => void
): TelegramClient['getUpdates'] {
  let call = 0
  return async (token, params, options) => {
    onPoll?.(token, params.offset)
    const batch = batches[call++]
    if (batch) return batch
    const aborted = Promise.withResolvers<void>()
    options?.signal?.addEventListener('abort', () => aborted.resolve(), { once: true })
    if (!options?.signal?.aborted) await aborted.promise
    return []
  }
}

function textUpdate(updateId: number, userId: number, text: string): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: 100 + updateId,
      from: { id: userId, is_bot: false, first_name: 'User' },
      chat: { id: userId, type: 'private' },
      date: 1000,
      text
    }
  }
}

// Orca's host refuses (invalid_params) a storage/settings value it cannot take as JSON. A user saw
// 'value: Invalid input' on their first authorized message; every host write here must be accepted.
for (const scenario of ['no Orca bots found', 'Orca bots found'] as const) {
  test(`an authorized first message makes no host call Orca refuses (${scenario})`, async () => {
    const host = mockHost({
      capabilities: CAPABILITIES,
      secrets: { botToken: '123456:TEST_TOKEN' },
      settings: { enabled: false, defaultBot: '', allowedUserIds: '555000111', proxyUrl: '', replyTimeoutSec: 300 }
    })
    const deps = makeMockDeps(scenario === 'no Orca bots found' ? { orcaCli: { listBots: async () => [] } } : {})
    const { controller, worker } = await mountController(host, {
      telegram: deps.telegram,
      orcaCli: deps.orcaCli,
      logFlushMs: 0
    })
    try {
      await within(controller.handleIncomingUpdate(textUpdate(681159817, 555000111, 'oi')), 'first message')
      assert.deepEqual(host.refusals, [])
      const lastReply = deps.sentMessages.at(-1)?.text ?? ''
      assert.equal([t('en').errorGeneric, t('en').errorOrcaUnreachable, t('en').errorTimeout].includes(lastReply), false)
      if (scenario === 'no Orca bots found') assert.equal(lastReply, t('en').noBotsAvailable)
    } finally {
      await within(controller.dispose(), 'dispose')
      await worker.deactivate()
    }
  })
}

// Orca's NO_REPLY: a bot answer that is only the marker says nothing, so Telegram gets no reply.
test('a direct reply that is only NO_REPLY sends nothing to Telegram; words before it still go', async () => {
  const host = mockHost({
    capabilities: CAPABILITIES,
    secrets: { botToken: '123456:TEST_TOKEN' },
    settings: { enabled: false, defaultBot: 'Assistant', allowedUserIds: '555000111', proxyUrl: '', replyTimeoutSec: 300 }
  })
  const deps = makeMockDeps()
  let answer: string | null = null
  const readSession = deps.orcaCli.readSession
  deps.orcaCli.readSession = async (sessionId) => {
    const session = await readSession(sessionId)
    if (answer === null) return session
    const said = answer
    return {
      ...session,
      entries: session.entries.map((e) => (e.kind === 'message' && e.role === 'assistant' ? { ...e, text: said } : e))
    }
  }
  const { controller, worker } = await mountController(host, { telegram: deps.telegram, orcaCli: deps.orcaCli, logFlushMs: 0 })
  const repliesTo = (messageId: number) => deps.sentMessages.filter((m) => m.replyToMessageId === messageId)
  try {
    await within(controller.handleIncomingUpdate(textUpdate(1, 555000111, 'first')), 'normal reply')
    assert.equal(repliesTo(101).at(-1)?.text, 'Reply #1 from Assistant')

    answer = '**NO_REPLY.**'
    await within(controller.handleIncomingUpdate(textUpdate(2, 555000111, 'second')), 'quiet reply')
    assert.equal(deps.sentToBots.length, 2)
    assert.deepEqual(repliesTo(102), [])
    assert.equal(deps.sentMessages.some((m) => m.text.includes('NO_REPLY')), false)

    answer = 'Nothing changed. NO_REPLY'
    await within(controller.handleIncomingUpdate(textUpdate(3, 555000111, 'third')), 'words before the marker')
    assert.equal(repliesTo(103).at(-1)?.text, 'Nothing changed.')
  } finally {
    await within(controller.dispose(), 'dispose')
    await worker.deactivate()
  }
})

// Orca titles a new handoff chat "Telegram: <first words>"; the bridge names it after the Telegram
// chat so the owner can tell bridged chats apart, and never touches a title someone chose.
test('a bridged Orca chat under its automatic title is named telegram@<name>, once; a chosen title stays', async () => {
  const host = mockHost({
    capabilities: CAPABILITIES,
    secrets: { botToken: '123456:TEST_TOKEN' },
    settings: {
      enabled: false,
      defaultBot: 'Assistant',
      allowedUserIds: '555000111, 555000222',
      proxyUrl: '',
      replyTimeoutSec: 300
    }
  })
  const deps = makeMockDeps()
  const { controller, worker } = await mountController(host, { telegram: deps.telegram, orcaCli: deps.orcaCli, logFlushMs: 0 })
  const withUsername = (updateId: number, text: string): TelegramUpdate => {
    const update = textUpdate(updateId, 555000111, text)
    update.message!.from = { id: 555000111, is_bot: false, first_name: 'Ana', username: 'ana_dev' }
    return update
  }
  try {
    await within(controller.handleIncomingUpdate(withUsername(1, 'hello')), 'first message')
    // the mock's first new chat (Home is the first chat)
    const chatId = 'tg-chat-2'
    assert.equal(deps.sentToBots[0].chatId, 'new')
    // one "@": the username already carries it
    assert.deepEqual(deps.renamedChats, [{ sessionId: chatId, name: 'telegram@ana_dev' }])

    await within(controller.handleIncomingUpdate(withUsername(2, 'again')), 'second message')
    assert.equal(deps.renamedChats.length, 1)

    // a title the owner chose in Orca is kept
    await deps.orcaCli.renameChat(chatId, 'Project X')
    await within(controller.handleIncomingUpdate(withUsername(3, 'third')), 'chosen title')
    assert.equal(deps.renamedChats.at(-1)?.name, 'Project X')

    // a chosen title that only contains "Telegram: " stays too
    await deps.orcaCli.renameChat(chatId, 'Project: Telegram: roadmap')
    const renamesBefore = deps.renamedChats.length
    await within(controller.handleIncomingUpdate(withUsername(4, 'fourth')), 'chosen title with Telegram:')
    assert.equal(deps.renamedChats.length, renamesBefore)

    // Orca's automatic title behind the sender is replaced
    await deps.orcaCli.renameChat(chatId, "your owner's agent: Telegram: hi")
    await within(controller.handleIncomingUpdate(withUsername(5, 'fifth')), "owner's agent title")
    assert.equal(deps.renamedChats.at(-1)?.name, 'telegram@ana_dev')

    // without a username: first name
    await within(controller.handleIncomingUpdate(textUpdate(6, 555000222, 'hi')), 'no username')
    assert.equal(deps.renamedChats.at(-1)?.name, 'telegram@User')
  } finally {
    await within(controller.dispose(), 'dispose')
    await worker.deactivate()
  }
})

// Orca rejects a panel handler answer that is not plain JSON ("answered with a non-JSON value"), and
// mockHost does not check answers, so this mirrors Orca's rule: the first non-JSON value's path, or null.
function nonJsonPath(value: unknown, at = '$'): string | null {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return null
  if (typeof value === 'number') return Number.isFinite(value) ? null : at
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) {
      const found = nonJsonPath(item, `${at}[${i}]`)
      if (found) return found
    }
    return null
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const found = nonJsonPath(item, `${at}.${key}`)
      if (found) return found
    }
    return null
  }
  return at
}

test('panel handlers answer plain JSON after a message created a binding with no Orca bot', async () => {
  const host = mockHost({
    capabilities: CAPABILITIES,
    secrets: { botToken: '123456:TEST_TOKEN' },
    settings: { enabled: false, defaultBot: '', allowedUserIds: '555000111', proxyUrl: '', replyTimeoutSec: 300 }
  })
  const deps = makeMockDeps({ orcaCli: { listBots: async () => [] } })
  let manager!: BridgeManager
  const worker = await mountWorker(
    {
      default: async (orca: OrcaWorkerApi) => {
        manager = await main.activateWithDeps(orca, { telegram: deps.telegram, orcaCli: deps.orcaCli, logFlushMs: 0 })
      },
      deactivate: main.deactivate
    },
    { host }
  )
  try {
    await within(manager.bridges[0].handleIncomingUpdate(textUpdate(681159817, 555000111, 'oi')), 'first message')
    const enabled = await worker.request('bridge.setDebugLogging', { enabled: true })
    assert.equal(nonJsonPath(enabled), null)
    assert.equal((enabled as BridgeState).global.debugLogging, true)
    const state = await worker.request('bridge.getState')
    assert.equal(nonJsonPath(state), null)
    assert.equal((state as BridgeState).bridges[0].bindings.length, 1)
  } finally {
    await worker.deactivate()
  }
})

test('extractTablesFromMarkdown extracts GFM tables outside code fences', () => {
  const md = [
    '说明：',
    '| 名称 | 状态 |',
    '| --- | --- |',
    '| **DemoWorkspace** | 正常 |',
    '',
    '```md',
    '| code | fence |',
    '| --- | --- |',
    '| a | b |',
    '```'
  ].join('\n')
  const { textWithMarkers, tables } = extractTablesFromMarkdown(md, t('en').tableMarker)
  assert.equal(tables.length, 1)
  assert.deepEqual(tables[0].headers, ['名称', '状态'])
  assert.deepEqual(tables[0].rows, [['DemoWorkspace', '正常']])
  assert.match(textWithMarkers, /📊 \*\*Table 1\*\* \(see image below\)/)
  assert.match(textWithMarkers, /\| code \| fence \|/)
})

test('markdownToTelegramHtml formats headings, bold, italic, strike, quote, tasks, code, and tables', () => {
  const html = markdownToTelegramHtml(
    [
      '### 标题 <test>',
      '**粗体** *斜体* ***粗斜体*** ~~删除~~ `C:\\path` [链接](https://example.com/a_b)',
      '> 第一行引用',
      '> 第二行引用',
      '- [x] 已完成',
      '- [] 未完成',
      '---',
      '| 名称 | 状态 |',
      '| --- | --- |',
      '| km | OK |',
      '| 名称 | 类型 | 状态 | 备注 |',
      '| --- | --- | --- | --- |',
      '| DemoWorkspace | 笔记库 | 正常 | 路径 `/workspace/notes` |',
      '```ts',
      'const a = 1 < 2',
      '```'
    ].join('\n')
  )
  assert.match(html, /<b>标题 &lt;test&gt;<\/b>/)
  assert.match(html, /<b>粗体<\/b> <i>斜体<\/i> <b><i>粗斜体<\/i><\/b> <s>删除<\/s>/)
  assert.match(html, /<code>C:\\path<\/code>/)
  assert.match(html, /<a href="https:\/\/example\.com\/a_b">链接<\/a>/)
  assert.match(html, /<blockquote>第一行引用\n第二行引用<\/blockquote>/)
  assert.match(html, /✅ 已完成/)
  assert.match(html, /⬜ 未完成/)
  assert.match(html, /──────────/)
  assert.match(html, /<pre><code>名称\s+│ 状态/)
  assert.match(html, /• <b>DemoWorkspace<\/b>\n  类型: 笔记库 ｜ 状态: 正常 ｜ 备注: 路径 <code>\/workspace\/notes<\/code>/)
  assert.match(html, /<pre><code class="language-ts">const a = 1 &lt; 2<\/code><\/pre>/)
})

test('splitTelegramMessage splits long messages cleanly', () => {
  const longText = Array.from({ length: 120 }, (_, i) => `Line ${i}: ${'x'.repeat(50)}`).join('\n')
  const parts = splitTelegramMessage(longText, 1000)
  assert.ok(parts.length > 1)
  for (const part of parts) {
    assert.ok(part.length <= 1000)
  }
})

test('worker activates cleanly without token and saves config', async () => {
  const host = mockHost({
    capabilities: ['storage:own', 'secrets:own', 'settings:own', 'notifications:show'],
    settings: { enabled: false, defaultBot: '', allowedUserIds: '', proxyUrl: '', replyTimeoutSec: 300 }
  })
  const worker = await mountWorker(main, { host })
  const initial = (await worker.request('bridge.getState')) as BridgeState
  assert.equal(initial.bridges.length, 1)
  assert.equal(initial.bridges[0].name, 'Bridge 1')
  assert.equal(initial.bridges[0].status, 'needs_token')
  assert.equal(initial.bridges[0].config.hasToken, false)

  const saved = (await worker.request('bridge.saveConfig', {
    bridgeId: initial.bridges[0].id,
    name: 'CI bot',
    botToken: '123456:TEST_TOKEN',
    enabled: false,
    orcaBot: 'Assistant',
    restricted: true,
    allowedUserIds: '42',
    proxyUrl: '',
    replyTimeoutSec: 120,
    syncOrcaOutbound: true
  })) as BridgeState
  const bridge = saved.bridges[0]
  assert.equal(bridge.status, 'stopped')
  assert.equal(bridge.name, 'CI bot')
  assert.equal(bridge.config.hasToken, true)
  assert.equal(bridge.config.allowedUserIds, '42')
  assert.equal(bridge.config.syncOrcaOutbound, true)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('worker activates and starts polling while Orca bot discovery hangs', async () => {
  const host = mockHost({
    capabilities: ['storage:own', 'secrets:own', 'settings:own', 'notifications:show'],
    secrets: { botToken: '123456:TEST_TOKEN' },
    settings: { enabled: true, defaultBot: '', allowedUserIds: '', proxyUrl: '', replyTimeoutSec: 300 }
  })
  const polled = Promise.withResolvers<void>()
  const deps = makeMockDeps({
    telegram: {
      async getUpdates(_token, _params, options) {
        polled.resolve()
        const aborted = Promise.withResolvers<void>()
        options?.signal?.addEventListener('abort', () => aborted.resolve(), { once: true })
        if (!options?.signal?.aborted) await aborted.promise
        return []
      }
    },
    orcaCli: {
      // `orca bot list --json` can hang on some hosts; startup must not wait for it.
      listBots: () => new Promise(() => {})
    }
  })
  // Real timer on purpose: it stands in for the host's ready deadline, so a regression fails instead of hanging.
  const deadline = Promise.withResolvers<string>()
  const timer = setTimeout(() => deadline.resolve('timed out'), 1000)
  const started = mountWorker(
    {
      default: (orca: OrcaWorkerApi) => main.activateWithDeps(orca, deps).then(() => undefined),
      deactivate: main.deactivate
    },
    { host }
  )
  const outcome = await Promise.race([
    Promise.all([started, polled.promise]).then(() => 'polling'),
    deadline.promise
  ])
  clearTimeout(timer)
  assert.equal(outcome, 'polling')
  await (await started).deactivate()
})

test('findUnsyncedTail aligns sliding windows and repeated messages accurately', () => {
  const items1 = extractMessageItems([
    { kind: 'message', role: 'user', text: 'first' },
    { kind: 'message', role: 'assistant', text: 'reply 1' },
    { kind: 'message', role: 'user', text: 'ok' }
  ])
  const tail = computeTailHashes(items1)

  // User sends the exact same text 'ok' again later
  const items2 = extractMessageItems([
    { kind: 'message', role: 'user', text: 'first' },
    { kind: 'message', role: 'assistant', text: 'reply 1' },
    { kind: 'message', role: 'user', text: 'ok' },
    { kind: 'message', role: 'assistant', text: 'reply 2' },
    { kind: 'message', role: 'user', text: 'ok' }
  ])
  const res = findUnsyncedTail(items2, tail)
  assert.equal(res.matched, true)
  assert.deepEqual(res.unsynced, [
    { role: 'assistant', text: 'reply 2' },
    { role: 'user', text: 'ok' }
  ])

  // Sliding window drops earliest item ('first') but still aligns on trailing suffix
  const slid = items2.slice(1)
  const slidRes = findUnsyncedTail(slid, tail)
  assert.equal(slidRes.matched, true)
  assert.deepEqual(slidRes.unsynced, [
    { role: 'assistant', text: 'reply 2' },
    { role: 'user', text: 'ok' }
  ])
})

test('syncOrcaBoundChatsOnce forwards Orca-side user messages and bot replies without duplicating TG turns', async () => {
  const boundChatId = 'orca-bound-1'
  let chatActivityAt = 1000
  const session: OrcaSessionRead = {
    orcaSessionId: boundChatId,
    state: 'done',
    entries: [
      { kind: 'message', role: 'user', text: 'Old history question' },
      { kind: 'message', role: 'assistant', text: 'Old history reply' }
    ]
  }
  const sentMessages: { chatId: number | string; text: string }[] = []

  const host = mockHost({
    capabilities: ['storage:own', 'secrets:own', 'settings:own', 'notifications:show'],
    secrets: { botToken: '123456:TEST_TOKEN' },
    settings: {
      enabled: false,
      defaultBot: 'Assistant',
      allowedUserIds: '777888',
      proxyUrl: '',
      replyTimeoutSec: 300,
      syncOrcaOutbound: true
    },
    storage: {
      'tg.bindings': [
        {
          tgChatId: '777888',
          botId: 'bot-1',
          botName: 'Assistant',
          orcaChatId: boundChatId,
          updatedAt: 1000
        }
      ]
    }
  })

  const deps = makeMockDeps({
    telegram: {
      async sendMessage(_token, params) {
        sentMessages.push({ chatId: params.chatId, text: params.text })
        return {
          message_id: 100 + sentMessages.length,
          chat: { id: Number(params.chatId), type: 'private' },
          date: 1000,
          text: params.text
        }
      }
    },
    orcaCli: {
      async listBotChats() {
        return [
          {
            id: boundChatId,
            title: 'Bound Chat',
            lastActivityAt: chatActivityAt,
            lastAsked: null,
            lastSaid: null,
            home: false,
            self: false,
            closed: false
          }
        ]
      },
      async readSession() {
        return { ...session, entries: [...session.entries] }
      }
    }
  })

  const { manager, controller, worker: capturedWorker } = await mountController(host, {
    telegram: deps.telegram,
    orcaCli: deps.orcaCli,
    pollIntervalMs: 10
  })

  // 1. First sync pass establishes baseline without dumping old history
  await controller.syncOrcaBoundChatsOnce()
  assert.equal(sentMessages.length, 0)

  // 2. User sends a message directly in Orca UI while bot is still working
  chatActivityAt = 2000
  session.state = 'working'
  session.entries.push({ kind: 'message', role: 'user', text: 'Check today tasks in Orca' })
  session.entries.push({ kind: 'message', role: 'assistant', text: 'Partial draft...' })

  await controller.syncOrcaBoundChatsOnce()
  // User prompt forwards immediately; partial assistant output waits until done
  assert.equal(sentMessages.length, 1)
  assert.match(sentMessages[0].text, /Check today tasks in Orca/)

  // 3. Bot finishes in Orca -> assistant reply forwards to Telegram
  session.state = 'done'
  session.entries.push({ kind: 'message', role: 'assistant', text: 'Final answer.' })

  await controller.syncOrcaBoundChatsOnce()
  assert.equal(sentMessages.length, 2)
  assert.match(sentMessages[1].text, /Partial draft\.\.\./)
  assert.match(sentMessages[1].text, /Final answer\./)

  // 4. Subsequent poll with no new activity sends nothing
  await controller.syncOrcaBoundChatsOnce()
  assert.equal(sentMessages.length, 2)

  // 5. Turning syncOrcaOutbound off stops forwarding new Orca messages
  await manager.saveConfig(saveInput(controller, { enabled: false, syncOrcaOutbound: false }))
  chatActivityAt = 3000
  session.entries.push({ kind: 'message', role: 'user', text: 'Should stay local' })
  session.entries.push({ kind: 'message', role: 'assistant', text: 'Local reply' })
  await controller.syncOrcaBoundChatsOnce()
  assert.equal(sentMessages.length, 2)

  await controller.dispose()
  await capturedWorker.deactivate()
})

test('sync skips Orca automation prompts, scheduled runs and NO_REPLY answers but forwards the answers', async () => {
  const boundChatId = 'orca-bound-auto'
  let chatActivityAt = 1000
  const session: OrcaSessionRead = {
    orcaSessionId: boundChatId,
    state: 'done',
    entries: [
      { kind: 'message', role: 'user', text: 'Old question' },
      { kind: 'message', role: 'assistant', text: 'Old reply' }
    ]
  }
  const sent: string[] = []
  let runReads = 0
  const host = mockHost({
    capabilities: ['storage:own', 'secrets:own', 'settings:own', 'notifications:show'],
    secrets: { botToken: '123456:TEST_TOKEN' },
    settings: {
      enabled: false,
      defaultBot: 'Assistant',
      allowedUserIds: '777888',
      proxyUrl: '',
      replyTimeoutSec: 300,
      syncOrcaOutbound: true
    },
    storage: {
      'tg.bindings': [
        { tgChatId: '777888', botId: 'bot-1', botName: 'Assistant', orcaChatId: boundChatId, updatedAt: 1000 }
      ]
    }
  })
  const deps = makeMockDeps({
    telegram: {
      async sendMessage(_token, params) {
        sent.push(params.text)
        return { message_id: 100 + sent.length, chat: { id: Number(params.chatId), type: 'private' }, date: 1000 }
      }
    },
    orcaCli: {
      async listBotChats() {
        return [
          {
            id: boundChatId,
            title: 'Bound Chat',
            lastActivityAt: chatActivityAt,
            lastAsked: null,
            lastSaid: null,
            home: false,
            self: false,
            closed: false
          }
        ]
      },
      async readSession() {
        return { ...session, entries: [...session.entries] }
      },
      // Orca runs an automation in a reused chat by sending its prompt with no marker.
      async listAutomations() {
        return [
          { id: 'auto-daily', name: 'Daily balance', enabled: true, prompt: 'Check the balance and post it.' },
          // Ran in another chat: the same words typed here are the owner's.
          { id: 'auto-other', name: 'Elsewhere', enabled: true, prompt: 'Typed in Orca' }
        ]
      },
      async listAutomationRuns() {
        runReads++
        return [
          { automationId: 'auto-daily', chatSessionId: boundChatId, startedAt: Date.now() },
          { automationId: 'auto-other', chatSessionId: 'another-chat', startedAt: Date.now() }
        ]
      }
    }
  })
  const { controller, worker } = await mountController(host, {
    telegram: deps.telegram,
    orcaCli: deps.orcaCli,
    pollIntervalMs: 10
  })
  try {
    await controller.syncOrcaBoundChatsOnce()
    assert.equal(sent.length, 0)

    // A reminder fires: Orca writes the run prompt as a user message, then the bot answers.
    chatActivityAt = 2000
    session.entries.push({
      kind: 'message',
      role: 'user',
      text: 'Reminder set by the Telegram user. Reply with exactly: "⏰ Check the balance."\n\n[Orca: it is 2026-11-25T16:27:59.000Z, the time you were asked to act at. This is the only run.]'
    })
    session.entries.push({ kind: 'message', role: 'assistant', text: '⏰ Check the balance.' })
    await controller.syncOrcaBoundChatsOnce()
    assert.equal(sent.length, 1)
    assert.match(sent[0], /Check the balance/)
    assert.equal(/time you were asked to act at|Reminder set by/.test(sent[0]), false)

    // A run that ends quiet sends nothing, on this tick or the next.
    chatActivityAt = 3000
    session.entries.push({
      kind: 'message',
      role: 'user',
      text: 'Look up the balance and report it.\n\n[Orca: it is 2026-11-25T16:45:00.000Z, the time you were asked to act at. This is the only run.]'
    })
    session.entries.push({ kind: 'message', role: 'assistant', text: 'NO_REPLY' })
    await controller.syncOrcaBoundChatsOnce()
    await controller.syncOrcaBoundChatsOnce()
    assert.equal(sent.length, 1)

    // A scheduled run of an automation in this reused chat: only the bot's answer goes.
    chatActivityAt = 3500
    session.entries.push({ kind: 'message', role: 'user', text: 'Check the balance and post it.\r\n' })
    session.entries.push({ kind: 'message', role: 'assistant', text: 'Balance: 10.' })
    await controller.syncOrcaBoundChatsOnce()
    assert.equal(sent.length, 2)
    // Orca's runs are read only once a message may be a scheduled run, once per sync cycle.
    assert.equal(runReads, 1)
    assert.match(sent[1], /Balance: 10\./)

    // What the owner types in Orca still reaches Telegram, even when an automation elsewhere has
    // the same words.
    chatActivityAt = 4000
    session.entries.push({ kind: 'message', role: 'user', text: 'Typed in Orca' })
    session.entries.push({ kind: 'message', role: 'assistant', text: 'Done.' })
    await controller.syncOrcaBoundChatsOnce()
    assert.equal(sent.length, 4)
    assert.equal(runReads, 2)
    assert.match(sent[2], /Typed in Orca/)
    assert.match(sent[3], /Done\./)

    // Mail from another agent (the bot's Home Chat asking it to message this user): only the bot's
    // answer goes.
    chatActivityAt = 5000
    session.entries.push({
      kind: 'message',
      role: 'user',
      text: '──── From: ORCA_SESSION_ID:9863D830 (orca_session_id:9863d830) (handoff) ────\nSubject: Release note\nSend the user: New version is live.\n[Reply: orca orchestration reply --id msg_1 --body "..."]\n────────────────────────────────────────────────────────────'
    })
    session.entries.push({ kind: 'message', role: 'assistant', text: 'New version is live.' })
    await controller.syncOrcaBoundChatsOnce()
    assert.equal(sent.length, 5)
    assert.match(sent[4], /New version is live\./)
    assert.equal(/From:|Subject:|orchestration reply/.test(sent[4]), false)
  } finally {
    await controller.dispose()
    await worker.deactivate()
  }
})

test('controller blocks unauthorized users, auto-picks bot, runs slash commands, and bridges multi-turn chat', async () => {
  const host = mockHost({
    capabilities: ['storage:own', 'secrets:own', 'settings:own', 'notifications:show'],
    secrets: { botToken: '123456:TEST_TOKEN' },
    settings: { enabled: false, defaultBot: '', allowedUserIds: '42', proxyUrl: '', replyTimeoutSec: 300 }
  })

  const deps = makeMockDeps()
  const { manager, controller, worker: capturedWorker } = await mountController(host, {
    telegram: deps.telegram,
    orcaCli: deps.orcaCli,
    pollIntervalMs: 10
  })

  // An empty defaultBot moves over as an empty Orca bot: the first bot found answers.
  assert.equal(controller.view().config.orcaBot, '')

  // 1. With a restricted allowlist, an unlisted message is blocked and notifies sender of their numeric ID
  await controller.testConnection()
  assert.equal(deps.registeredCommands.length, 1)
  assert.ok(deps.registeredCommands[0].some((c) => c.command === 'new'))

  await controller.handleIncomingUpdate({
    update_id: 1,
    message: {
      message_id: 10,
      from: { id: 777888, is_bot: false, first_name: 'Demo', username: 'demouser' },
      chat: { id: 777888, type: 'private' },
      date: 1000,
      text: 'hello'
    }
  })
  assert.equal(deps.sentToBots.length, 0)
  assert.equal(controller.view().lastBlockedUserId, '777888')
  assert.match(deps.sentMessages[0].text, /777888/)

  // 2. Allow the user ID and send a real message -> creates new Orca chat & replies. Allow gives
  // the Member role; the owner then gives this person Full access for the commands below.
  await controller.allowUserId('777888')
  assert.equal(controller.view().config.roleAssignments['777888'], 'member')
  await manager.saveConfig(saveInput(controller, { roleAssignments: { '42': 'full', '777888': 'full' } }))
  await controller.handleIncomingUpdate({
    update_id: 2,
    message: {
      message_id: 11,
      from: { id: 777888, is_bot: false, first_name: 'Demo', username: 'demouser' },
      chat: { id: 777888, type: 'private' },
      date: 1001,
      text: 'Summarize my recent notes'
    }
  })
  assert.equal(deps.sentToBots.length, 1)
  assert.equal(deps.sentToBots[0].chatId, 'new')
  assert.equal(deps.sentMessages[1].text, 'Reply #1 from Assistant')

  // 3. Follow-up message reuses the bound Orca chat ID
  await controller.handleIncomingUpdate({
    update_id: 3,
    message: {
      message_id: 12,
      from: { id: 777888, is_bot: false, first_name: 'Demo', username: 'demouser' },
      chat: { id: 777888, type: 'private' },
      date: 1002,
      text: 'List folders'
    }
  })
  assert.equal(deps.sentToBots.length, 2)
  assert.equal(deps.sentToBots[1].chatId, 'tg-chat-2')
  assert.equal(deps.sentMessages[2].text, 'Reply #2 from Assistant')

  // 4. /use does not switch: this Telegram bot is pinned to its Orca bot, and the chat stays bound
  await controller.handleIncomingUpdate({
    update_id: 4,
    message: {
      message_id: 13,
      from: { id: 777888, is_bot: false, first_name: 'Demo', username: 'demouser' },
      chat: { id: 777888, type: 'private' },
      date: 1003,
      text: '/use Daily standup notes'
    }
  })
  assert.equal(deps.sentToBots.length, 2)
  assert.equal(deps.sentMessages[3].text, t('en').botPinned('Assistant'))
  assert.equal(controller.view().bindings[0].botId, 'bot-1')
  assert.equal(controller.view().bindings[0].botName, 'Assistant')
  assert.equal(controller.view().bindings[0].orcaChatId, 'tg-chat-2')

  // 5. /new preserves botId while clearing orcaChatId
  await controller.handleIncomingUpdate({
    update_id: 5,
    message: {
      message_id: 14,
      from: { id: 777888, is_bot: false, first_name: 'Demo', username: 'demouser' },
      chat: { id: 777888, type: 'private' },
      date: 1004,
      text: '/new'
    }
  })
  assert.equal(controller.view().bindings[0].botId, 'bot-1')
  assert.equal(controller.view().bindings[0].orcaChatId, null)

  assert.deepEqual(capturedWorker.refusals, [])
  await controller.dispose()
  await capturedWorker.deactivate()
})

test('controller downloads Telegram photo and image document and passes local paths to Orca bot', async () => {
  const tempDownloadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-tg-bridge-test-'))
  const downloadedFileIds: string[] = []
  const host = mockHost({
    capabilities: ['storage:own', 'secrets:own', 'settings:own', 'notifications:show'],
    secrets: { botToken: '123456:TEST_TOKEN' },
    settings: {
      enabled: false,
      defaultBot: 'Assistant',
      allowedUserIds: '777888',
      proxyUrl: '',
      replyTimeoutSec: 300,
      syncOrcaOutbound: false
    }
  })

  const deps = makeMockDeps({
    telegram: {
      async getFile(_token, fileId) {
        downloadedFileIds.push(fileId)
        return {
          file_id: fileId,
          file_unique_id: `u_${fileId}`,
          file_path: fileId === 'doc-png-1' ? 'documents/screenshot.png' : 'photos/photo_lg.jpg'
        }
      },
      async downloadFile(_token, filePath) {
        return Buffer.from(`bytes-for-${filePath}`)
      }
    }
  })

  const { controller, worker: capturedWorker } = await mountController(host, {
    telegram: deps.telegram,
    orcaCli: deps.orcaCli,
    downloadDir: tempDownloadDir,
    pollIntervalMs: 10
  })

  try {
    // 1. Compressed photo without caption picks largest resolution
    await controller.handleIncomingUpdate({
      update_id: 10,
      message: {
        message_id: 21,
        from: { id: 777888, is_bot: false, first_name: 'Demo', username: 'demouser' },
        chat: { id: 777888, type: 'private' },
        date: 2000,
        photo: [
          { file_id: 'photo-sm', file_unique_id: 'sm', width: 90, height: 90, file_size: 1200 },
          { file_id: 'photo-lg', file_unique_id: 'lg', width: 1280, height: 720, file_size: 48000 }
        ]
      }
    })

    assert.deepEqual(downloadedFileIds, ['photo-lg'])
    assert.equal(deps.sentToBots.length, 1)
    assert.match(deps.sentToBots[0].subject, /\[Image\]/)
    assert.match(deps.sentToBots[0].body, /Attached Telegram image\(s\) saved locally/)
    assert.match(deps.sentToBots[0].body, /\.jpg/)
    assert.equal(deps.sentMessages[0].text, 'Reply #1 from Assistant')

    // 2. Uncompressed image document with caption preserves .png and caption
    await controller.handleIncomingUpdate({
      update_id: 11,
      message: {
        message_id: 22,
        from: { id: 777888, is_bot: false, first_name: 'Demo', username: 'demouser' },
        chat: { id: 777888, type: 'private' },
        date: 2001,
        caption: 'Describe this screenshot',
        document: {
          file_id: 'doc-png-1',
          file_unique_id: 'doc1',
          file_name: '../../evil.png',
          mime_type: 'image/png',
          file_size: 2048
        }
      }
    })

    assert.deepEqual(downloadedFileIds, ['photo-lg', 'doc-png-1'])
    assert.equal(deps.sentToBots.length, 2)
    assert.match(deps.sentToBots[1].body, /\.png/)
    assert.match(deps.sentToBots[1].body, /Describe this screenshot/)
    assert.ok(!deps.sentToBots[1].body.includes('evil.png'))

    const savedFiles = await fs.readdir(tempDownloadDir)
    assert.equal(savedFiles.length, 2)
    assert.deepEqual(capturedWorker.refusals, [])
  } finally {
    await controller.dispose()
    await capturedWorker.deactivate()
    await fs.rm(tempDownloadDir, { recursive: true, force: true })
  }
})

test('controller supports interactive inline buttons, /sync, /home, /rename, and /automations + /run', async () => {
  const host = mockHost({
    capabilities: ['storage:own', 'secrets:own', 'settings:own', 'notifications:show'],
    secrets: { botToken: '123456:TEST_TOKEN' },
    settings: {
      enabled: false,
      defaultBot: 'Assistant',
      allowedUserIds: '777888',
      proxyUrl: '',
      replyTimeoutSec: 300,
      syncOrcaOutbound: false
    }
  })

  const deps = makeMockDeps()
  const { controller, worker: capturedWorker } = await mountController(host, {
    telegram: deps.telegram,
    orcaCli: deps.orcaCli,
    pollIntervalMs: 10
  })

  // 1. /bots lists the Orca bots, marks the linked one and offers no switch buttons
  await controller.handleIncomingUpdate({
    update_id: 20,
    message: {
      message_id: 30,
      from: { id: 777888, is_bot: false, first_name: 'Demo', username: 'demouser' },
      chat: { id: 777888, type: 'private' },
      date: 2000,
      text: '/bots'
    }
  })
  assert.equal(deps.sentMessages[0].replyMarkup, undefined)
  assert.match(deps.sentMessages[0].text, /• Assistant \(linked\)/)
  assert.match(deps.sentMessages[0].text, /• Daily standup notes — /)

  // Unauthorized callback is rejected
  await controller.handleIncomingUpdate({
    update_id: 21,
    callback_query: {
      id: 'cb-unauth',
      from: { id: 999999, is_bot: false, first_name: 'Stranger' },
      message: {
        message_id: 901,
        chat: { id: 999999, type: 'private' },
        date: 2001
      },
      data: 'u:bot-2'
    }
  })
  assert.equal(deps.answeredCallbacks[0].showAlert, true)
  assert.equal(controller.view().bindings[0].botName, 'Assistant')

  // An authorized press on a switch button from an old /bots message is answered, not obeyed
  await controller.handleIncomingUpdate({
    update_id: 22,
    callback_query: {
      id: 'cb-auth',
      from: { id: 777888, is_bot: false, first_name: 'Demo' },
      message: {
        message_id: 901,
        chat: { id: 777888, type: 'private' },
        date: 2002
      },
      data: 'u:bot-2'
    }
  })
  const switchAnswer = deps.answeredCallbacks.find((a) => a.callbackQueryId === 'cb-auth')
  assert.equal(switchAnswer?.text, t('en').botPinned('Assistant'))
  assert.equal(switchAnswer?.showAlert, true)
  assert.equal(controller.view().bindings[0].botName, 'Assistant')
  assert.equal(controller.view().bindings[0].botId, 'bot-1')

  // 2. /home binds to Home Chat and /rename renames it
  await controller.handleIncomingUpdate({
    update_id: 23,
    message: {
      message_id: 31,
      from: { id: 777888, is_bot: false, first_name: 'Demo' },
      chat: { id: 777888, type: 'private' },
      date: 2003,
      text: '/home'
    }
  })
  assert.equal(controller.view().bindings[0].orcaChatId, 'home-chat-1')

  await controller.handleIncomingUpdate({
    update_id: 24,
    message: {
      message_id: 32,
      from: { id: 777888, is_bot: false, first_name: 'Demo' },
      chat: { id: 777888, type: 'private' },
      date: 2004,
      text: '/rename Work Sync'
    }
  })
  assert.deepEqual(deps.renamedChats, [{ sessionId: 'home-chat-1', name: 'Work Sync' }])
  assert.equal(controller.view().bindings[0].title, 'Work Sync')

  // 3. /sync toggles syncOrcaOutbound via text and inline callback
  await controller.handleIncomingUpdate({
    update_id: 25,
    message: {
      message_id: 33,
      from: { id: 777888, is_bot: false, first_name: 'Demo' },
      chat: { id: 777888, type: 'private' },
      date: 2005,
      text: '/sync on'
    }
  })
  assert.equal(controller.view().config.syncOrcaOutbound, true)

  await controller.handleIncomingUpdate({
    update_id: 26,
    callback_query: {
      id: 'cb-sync-off',
      from: { id: 777888, is_bot: false, first_name: 'Demo' },
      message: {
        message_id: 904,
        chat: { id: 777888, type: 'private' },
        date: 2006
      },
      data: 's:off'
    }
  })
  assert.equal(controller.view().config.syncOrcaOutbound, false)

  // 4. /automations lists tasks with run buttons, and /run + button trigger them
  await controller.handleIncomingUpdate({
    update_id: 27,
    message: {
      message_id: 34,
      from: { id: 777888, is_bot: false, first_name: 'Demo' },
      chat: { id: 777888, type: 'private' },
      date: 2007,
      text: '/automations'
    }
  })
  const autoMsg = deps.sentMessages[deps.sentMessages.length - 1]
  assert.match(autoMsg.text, /Daily backup/)
  assert.equal(autoMsg.replyMarkup?.inline_keyboard[0][0].callback_data, 'r:auto-1')

  await controller.handleIncomingUpdate({
    update_id: 28,
    callback_query: {
      id: 'cb-run',
      from: { id: 777888, is_bot: false, first_name: 'Demo' },
      message: {
        message_id: 906,
        chat: { id: 777888, type: 'private' },
        date: 2008
      },
      data: 'r:auto-1'
    }
  })
  await controller.handleIncomingUpdate({
    update_id: 29,
    message: {
      message_id: 35,
      from: { id: 777888, is_bot: false, first_name: 'Demo' },
      chat: { id: 777888, type: 'private' },
      date: 2009,
      text: '/run auto-1'
    }
  })
  assert.deepEqual(deps.triggeredAutomations, ['auto-1', 'auto-1'])

  assert.deepEqual(capturedWorker.refusals, [])
  await controller.dispose()
  await capturedWorker.deactivate()
})

test('a slow bot reply in one Telegram chat does not hold up another chat', async () => {
  const host = mockHost({
    capabilities: CAPABILITIES,
    secrets: { botToken: '123456:TEST_TOKEN' },
    settings: { enabled: true, defaultBot: 'Assistant', allowedUserIds: '111, 222', proxyUrl: '', replyTimeoutSec: 300 }
  })
  const deps = makeMockDeps({
    telegram: {
      getUpdates: scriptedGetUpdates([[textUpdate(1, 111, 'slow question'), textUpdate(2, 222, 'quick question')]])
    }
  })
  const releaseA = Promise.withResolvers<void>()
  const replyA = Promise.withResolvers<void>()
  const replyB = Promise.withResolvers<void>()
  const baseSendToBot = deps.orcaCli.sendToBot
  deps.orcaCli.sendToBot = async (params) => {
    if (params.body.includes('chat 111')) await releaseA.promise
    return baseSendToBot(params)
  }
  const baseSendMessage = deps.telegram.sendMessage
  deps.telegram.sendMessage = async (token, params, options) => {
    const sent = await baseSendMessage(token, params, options)
    if (String(params.chatId) === '111') replyA.resolve()
    if (String(params.chatId) === '222') replyB.resolve()
    return sent
  }

  const { controller, worker } = await mountController(host, {
    telegram: deps.telegram,
    orcaCli: deps.orcaCli,
    pollIntervalMs: 1,
    retryBackoffMs: 1
  })
  try {
    await within(replyB.promise, 'chat 222 reply while chat 111 is still waiting')
    assert.ok(!deps.sentMessages.some((m) => String(m.chatId) === '111'))

    releaseA.resolve()
    await within(replyA.promise, 'chat 111 reply after its bot finishes')
    assert.equal(deps.sentMessages.find((m) => String(m.chatId) === '111')?.text, 'Reply #1 from Assistant')
    assert.equal(deps.sentMessages.find((m) => String(m.chatId) === '222')?.text, 'Reply #1 from Assistant')
  } finally {
    releaseA.resolve()
    await controller.dispose()
    await worker.deactivate()
  }
})

// With Auto, a chat's own texts keep its sender's language even while another chat, in another
// language, is handled in between.
test('with Auto, two chats handled side by side each get the bridge texts in their own language', async () => {
  const host = mockHost({
    capabilities: CAPABILITIES,
    secrets: { botToken: '123456:TEST_TOKEN' },
    settings: { enabled: true, defaultBot: 'Assistant', allowedUserIds: '111, 222', proxyUrl: '', replyTimeoutSec: 300, replyLanguage: 'auto' }
  })
  const portuguese = textUpdate(1, 111, 'pergunta lenta')
  portuguese.message!.from!.language_code = 'pt-br'
  const spanish = textUpdate(2, 222, 'pregunta rápida')
  spanish.message!.from!.language_code = 'es'
  const deps = makeMockDeps({ telegram: { getUpdates: scriptedGetUpdates([[portuguese, spanish]]) } })
  const releaseA = Promise.withResolvers<void>()
  const failedA = Promise.withResolvers<void>()
  const failedB = Promise.withResolvers<void>()
  // Both bots fail, so the bridge answers with its own text; chat 111's fails only after 222's.
  deps.orcaCli.sendToBot = async (params) => {
    if (params.body.includes('chat 111')) await releaseA.promise
    throw new Error('bot unavailable')
  }
  const baseSendMessage = deps.telegram.sendMessage
  deps.telegram.sendMessage = async (token, params, options) => {
    const sent = await baseSendMessage(token, params, options)
    if (String(params.chatId) === '111') failedA.resolve()
    if (String(params.chatId) === '222') failedB.resolve()
    return sent
  }
  const { controller, worker } = await within(
    mountController(host, { telegram: deps.telegram, orcaCli: deps.orcaCli, pollIntervalMs: 1, retryBackoffMs: 1 }),
    'mount'
  )
  try {
    await within(failedB.promise, 'chat 222 answered while chat 111 waits')
    releaseA.resolve()
    await within(failedA.promise, 'chat 111 answered after its bot fails')
    const textOf = (chatId: string) => deps.sentMessages.find((m) => String(m.chatId) === chatId)?.text ?? ''
    assert.equal(textOf('222'), t('es').errorGeneric)
    assert.equal(textOf('111'), t('pt-BR').errorGeneric)
  } finally {
    releaseA.resolve()
    await within(controller.dispose(), 'dispose')
    await worker.deactivate()
  }
})

test('pausing after Telegram rejects the token (401) does not hang while outbound sync is on', async () => {
  const host = mockHost({
    capabilities: CAPABILITIES,
    secrets: { botToken: '123456:BAD_TOKEN' },
    settings: {
      enabled: true,
      defaultBot: 'Assistant',
      allowedUserIds: '777888',
      proxyUrl: '',
      replyTimeoutSec: 300,
      syncOrcaOutbound: true
    }
  })
  const deps = makeMockDeps({
    telegram: {
      async getMe() {
        throw new TelegramApiError('Unauthorized', 401)
      }
    }
  })
  const { manager, controller, worker } = await mountController(host, {
    telegram: deps.telegram,
    orcaCli: deps.orcaCli,
    outboundPollIntervalMs: 1,
    retryBackoffMs: 1
  })
  try {
    // The poll loop must have ended on its own before the pause, or stopPolling would abort it itself.
    await until(() => !controller.view().polling, 'poll loop to exit after 401')
    assert.equal(controller.view().status, 'error')

    await within(manager.togglePolling(), 'togglePolling after a 401')
    assert.equal(controller.view().status, 'stopped')
    assert.equal(controller.view().config.enabled, false)
  } finally {
    await within(controller.dispose(), 'dispose after a 401')
    await worker.deactivate()
  }
})

test('status turns connected without waiting out a full long poll', async () => {
  const host = mockHost({
    capabilities: CAPABILITIES,
    secrets: { botToken: '123456:TEST_TOKEN' },
    settings: { enabled: true, defaultBot: 'Assistant', allowedUserIds: '777888', proxyUrl: '', replyTimeoutSec: 300 }
  })
  const deps = makeMockDeps({
    telegram: {
      // Like Telegram with no new updates: a long poll holds until the loop aborts, a short poll answers.
      async getUpdates(_token, params, options) {
        if ((params.timeoutSec ?? 0) > 0) {
          const aborted = Promise.withResolvers<void>()
          options?.signal?.addEventListener('abort', () => aborted.resolve(), { once: true })
          if (!options?.signal?.aborted) await aborted.promise
        }
        return []
      }
    }
  })
  const { controller, worker } = await mountController(host, { telegram: deps.telegram, orcaCli: deps.orcaCli })
  try {
    await until(() => controller.view().status === 'connected', 'status connected after the first poll')
  } finally {
    await within(controller.dispose(), 'dispose')
    await worker.deactivate()
  }
})

test('switching to a new bot token polls the new bot from offset 0 and reads its own @username', async () => {
  const host = mockHost({
    capabilities: CAPABILITIES,
    secrets: { botToken: '111:OLD_BOT' },
    settings: { enabled: true, defaultBot: 'Assistant', allowedUserIds: '777888', proxyUrl: '', replyTimeoutSec: 300 },
    storage: { 'tg.updateOffset': 50 }
  })
  const polls: { token: string; offset: number | undefined }[] = []
  const polledOld = Promise.withResolvers<void>()
  const polledNew = Promise.withResolvers<void>()
  const deps = makeMockDeps({
    telegram: {
      async getMe(token) {
        const isNew = token.startsWith('222:')
        return { id: isNew ? 222 : 111, is_bot: true, first_name: 'Bot', username: isNew ? 'new_bot' : 'old_bot' }
      },
      getUpdates: scriptedGetUpdates([], (token, offset) => {
        polls.push({ token, offset })
        if (token === '111:OLD_BOT') polledOld.resolve()
        if (token === '222:NEW_BOT') polledNew.resolve()
      })
    }
  })
  const { manager, controller, worker } = await mountController(host, { telegram: deps.telegram, orcaCli: deps.orcaCli })
  try {
    await within(polledOld.promise, 'first poll with the old token')
    assert.equal(polls[0].offset, 50)

    await within(
      manager.saveConfig(saveInput(controller, { botToken: '222:NEW_BOT', enabled: true })),
      'saveConfig with a new token'
    )
    await within(polledNew.promise, 'first poll with the new token')

    // The old bot's offset would make Telegram confirm, and so drop, the new bot's pending updates.
    const newPolls = polls.filter((p) => p.token === '222:NEW_BOT')
    assert.ok(newPolls.every((p) => p.offset === undefined))
    assert.equal(controller.view().botUsername, 'new_bot')
    assert.equal(deps.registeredCommands.length, 2)
  } finally {
    await controller.dispose()
    await worker.deactivate()
  }
})

test('saving settings that do not touch the connection keeps an in-flight reply running', async () => {
  const host = mockHost({
    capabilities: CAPABILITIES,
    secrets: { botToken: '123456:TEST_TOKEN' },
    settings: { enabled: true, defaultBot: 'Assistant', allowedUserIds: '777888', proxyUrl: '', replyTimeoutSec: 300 }
  })
  const deps = makeMockDeps({
    telegram: { getUpdates: scriptedGetUpdates([[textUpdate(1, 777888, 'long task')]]) }
  })
  const entered = Promise.withResolvers<AbortSignal | undefined>()
  const release = Promise.withResolvers<void>()
  const replied = Promise.withResolvers<void>()
  const baseSendToBot = deps.orcaCli.sendToBot
  deps.orcaCli.sendToBot = async (params) => {
    entered.resolve(params.signal)
    await release.promise
    return baseSendToBot(params)
  }
  const baseSendMessage = deps.telegram.sendMessage
  deps.telegram.sendMessage = async (token, params, options) => {
    const sent = await baseSendMessage(token, params, options)
    if (String(params.chatId) === '777888') replied.resolve()
    return sent
  }

  const { manager, controller, worker } = await mountController(host, {
    telegram: deps.telegram,
    orcaCli: deps.orcaCli,
    pollIntervalMs: 1
  })
  try {
    const signal = await within(entered.promise, 'the reply to reach the Orca bot')
    await within(
      manager.saveConfig(
        saveInput(controller, { enabled: true, allowedUserIds: '777888, 42', replyTimeoutSec: 600, syncOrcaOutbound: true })
      ),
      'saveConfig while a reply is running'
    )
    assert.equal(controller.view().config.replyTimeoutSec, 600)
    assert.equal(signal?.aborted, false)

    release.resolve()
    await within(replied.promise, 'the reply to reach Telegram')
    assert.equal(deps.sentMessages[0].text, 'Reply #1 from Assistant')
    assert.ok(!deps.sentMessages.some((m) => m.text === t('en').errorGeneric))
  } finally {
    release.resolve()
    await controller.dispose()
    await worker.deactivate()
  }
})

test('an Orca CLI failure in /home or a Home button answers the user and keeps polling healthy', async () => {
  const host = mockHost({
    capabilities: CAPABILITIES,
    secrets: { botToken: '123456:TEST_TOKEN' },
    settings: { enabled: true, defaultBot: 'Assistant', allowedUserIds: '777888', proxyUrl: '', replyTimeoutSec: 300 }
  })
  const deps = makeMockDeps({
    telegram: { getUpdates: scriptedGetUpdates([[textUpdate(1, 777888, '/home')]]) },
    orcaCli: {
      async listBotChats() {
        throw new Error('orca bot chats failed: exit 1')
      }
    }
  })
  const replied = Promise.withResolvers<void>()
  const baseSendMessage = deps.telegram.sendMessage
  deps.telegram.sendMessage = async (token, params, options) => {
    const sent = await baseSendMessage(token, params, options)
    replied.resolve()
    return sent
  }

  const { controller, worker } = await mountController(host, { telegram: deps.telegram, orcaCli: deps.orcaCli })
  try {
    await within(replied.promise, 'an error reply to /home')
    // A plain line, never the CLI's own text; the command never reached the Orca bot, so it may be retried.
    assert.equal(deps.sentMessages[0].text, t('en').errorGeneric)
    assert.match(deps.sentMessages[0].replyMarkup?.inline_keyboard[0][0].callback_data ?? '', /^x:/)
    assert.equal(controller.view().status, 'connected')
    assert.equal(controller.view().lastError, null)

    await controller.handleIncomingUpdate({
      update_id: 2,
      callback_query: {
        id: 'cb-home',
        from: { id: 777888, is_bot: false, first_name: 'Demo' },
        message: { message_id: 900, chat: { id: 777888, type: 'private' }, date: 1001 },
        data: 'c:home'
      }
    })
    const answer = deps.answeredCallbacks[deps.answeredCallbacks.length - 1]
    assert.equal(answer?.callbackQueryId, 'cb-home')
    assert.equal(answer?.showAlert, true)
    assert.equal(controller.view().status, 'connected')
  } finally {
    await controller.dispose()
    await worker.deactivate()
  }
})

test('outbound sync stops for a chat whose Telegram user was removed from the allowlist', async () => {
  const activity: Record<string, number> = { 'orca-group': 1000, 'orca-private': 1000 }
  const sessions: Record<string, OrcaSessionRead> = {
    // Sync needs earlier history to anchor on; an empty baseline only re-baselines.
    'orca-group': {
      orcaSessionId: 'orca-group',
      state: 'done',
      entries: [{ kind: 'message', role: 'assistant', text: 'Group history' }]
    },
    'orca-private': {
      orcaSessionId: 'orca-private',
      state: 'done',
      entries: [{ kind: 'message', role: 'assistant', text: 'Private history' }]
    }
  }
  const addTurn = (orcaChatId: string, text: string) => {
    activity[orcaChatId] += 1000
    sessions[orcaChatId].entries.push({ kind: 'message', role: 'user', text })
    sessions[orcaChatId].entries.push({ kind: 'message', role: 'assistant', text: `Answer to ${text}` })
  }
  const host = mockHost({
    capabilities: CAPABILITIES,
    secrets: { botToken: '123456:TEST_TOKEN' },
    settings: {
      enabled: false,
      defaultBot: 'Assistant',
      allowedUserIds: '555, 777888',
      proxyUrl: '',
      replyTimeoutSec: 300,
      syncOrcaOutbound: true
    },
    storage: {
      'tg.bindings': [
        // This group chat id is not on the allowlist; the user who used it last is.
        { tgChatId: '-100500', ownerUserId: '555', botId: 'bot-1', botName: 'Assistant', orcaChatId: 'orca-group', updatedAt: 1000 },
        { tgChatId: '777888', botId: 'bot-1', botName: 'Assistant', orcaChatId: 'orca-private', updatedAt: 1000 }
      ]
    }
  })
  const deps = makeMockDeps({
    orcaCli: {
      async listBotChats() {
        return Object.keys(sessions).map((id) => ({
          id,
          title: id,
          lastActivityAt: activity[id],
          lastAsked: null,
          lastSaid: null,
          home: false,
          self: false,
          closed: false
        }))
      },
      async readSession(sessionId) {
        const s = sessions[sessionId]
        return { ...s, entries: [...s.entries] }
      }
    }
  })
  const { manager, controller, worker } = await mountController(host, { telegram: deps.telegram, orcaCli: deps.orcaCli })
  try {
    await controller.syncOrcaBoundChatsOnce()
    assert.equal(deps.sentMessages.length, 0)

    addTurn('orca-group', 'group turn 1')
    addTurn('orca-private', 'private turn 1')
    await controller.syncOrcaBoundChatsOnce()
    assert.ok(deps.sentMessages.some((m) => String(m.chatId) === '-100500'))
    assert.ok(deps.sentMessages.some((m) => String(m.chatId) === '777888'))

    await manager.saveConfig(saveInput(controller, { enabled: false, allowedUserIds: '777888', syncOrcaOutbound: true }))
    deps.sentMessages.length = 0
    addTurn('orca-group', 'group turn 2')
    addTurn('orca-private', 'private turn 2')
    await controller.syncOrcaBoundChatsOnce()
    assert.ok(!deps.sentMessages.some((m) => String(m.chatId) === '-100500'))
    assert.ok(deps.sentMessages.some((m) => /private turn 2/.test(m.text)))
  } finally {
    await controller.dispose()
    await worker.deactivate()
  }
})

test('an SVG image document is refused instead of being handed to the bot as .jpg', async () => {
  const host = mockHost({
    capabilities: CAPABILITIES,
    secrets: { botToken: '123456:TEST_TOKEN' },
    settings: { enabled: false, defaultBot: 'Assistant', allowedUserIds: '777888', proxyUrl: '', replyTimeoutSec: 300 }
  })
  const deps = makeMockDeps({
    telegram: {
      async getFile() {
        throw new Error('getFile must not be called for an unsupported image')
      }
    }
  })
  const { controller, worker } = await mountController(host, { telegram: deps.telegram, orcaCli: deps.orcaCli })
  try {
    await controller.handleIncomingUpdate({
      update_id: 1,
      message: {
        message_id: 40,
        from: { id: 777888, is_bot: false, first_name: 'Demo' },
        chat: { id: 777888, type: 'private' },
        date: 1000,
        caption: 'What is in this diagram?',
        document: {
          file_id: 'doc-svg',
          file_unique_id: 'svg1',
          file_name: 'diagram.svg',
          mime_type: 'image/svg+xml',
          file_size: 512
        }
      }
    })
    assert.equal(deps.sentToBots.length, 0)
    assert.match(deps.sentMessages[0].text, /This image format is not supported/)
  } finally {
    await controller.dispose()
    await worker.deactivate()
  }
})

test('a saved bridge survives a restart and leaves the plugin settings alone', async () => {
  const host = mockHost({
    capabilities: CAPABILITIES,
    secrets: { botToken: '123456:TEST_TOKEN' },
    settings: { enabled: true, defaultBot: 'Assistant', allowedUserIds: '777888', proxyUrl: '', replyTimeoutSec: 300 }
  })
  const settingsBefore = JSON.stringify(host.data().settings)
  const deps = makeMockDeps({ telegram: { getUpdates: scriptedGetUpdates([]) } })
  const first = await mountController(host, deps)
  const bridgeId = first.controller.id
  try {
    await first.worker.request(
      'bridge.saveConfig',
      saveInput(first.controller, {
        name: 'Work bot',
        enabled: false,
        proxyUrl: 'http://127.0.0.1:8080',
        replyTimeoutSec: 120,
        syncOrcaOutbound: true
      })
    )
  } finally {
    await first.worker.deactivate()
  }
  assert.equal(JSON.stringify(host.data().settings), settingsBefore)

  const second = await mountController(host, deps)
  try {
    const state = (await second.worker.request('bridge.getState')) as BridgeState
    assert.equal(state.bridges.length, 1)
    const bridge = state.bridges[0]
    assert.equal(bridge.id, bridgeId)
    assert.equal(bridge.name, 'Work bot')
    assert.equal(bridge.config.hasToken, true)
    assert.equal(bridge.config.enabled, false)
    assert.equal(bridge.config.proxyUrl, 'http://127.0.0.1:8080')
    assert.equal(bridge.config.replyTimeoutSec, 120)
    assert.equal(bridge.config.syncOrcaOutbound, true)
    assert.equal(bridge.status, 'stopped')
    assert.equal(bridge.polling, false)
  } finally {
    await second.worker.deactivate()
  }
})

// A real-looking token: the redaction tests must not pass just because a fake token looks unusual.
const REAL_TOKEN = '7251846039:AAH3kVx9QzLm2pR8sT4uW6yZ0bC1dE5fG7h'

// A host in the 0.5.0 layout: each seed is one bridge with its config in `bridges`, its token in
// `botToken.<id>` and its state under `tg.<id>.*`. Plugin settings hold only debugLogging.
type BridgeSeed = {
  id: string
  token?: string
  voiceKey?: string
  config?: Record<string, JsonValue>
  state?: Partial<Record<'offset' | 'bindings' | 'syncCursors' | 'lastBlocked' | 'commandScopes' | 'knownNames', JsonValue>>
}

function bridgesHost(
  seeds: BridgeSeed[],
  options: { debugLogging?: boolean; storage?: Record<string, JsonValue> } = {}
) {
  const storage: Record<string, JsonValue> = { ...options.storage }
  const secrets: Record<string, string> = {}
  storage.bridges = seeds.map((seed, i) => ({
    id: seed.id,
    name: `Bridge ${i + 1}`,
    enabled: false,
    orcaBot: 'Assistant',
    allowedUserIds: '777888',
    proxyUrl: '',
    replyTimeoutSec: 300,
    syncOrcaOutbound: false,
    replyLanguage: 'en',
    ...seed.config
  }))
  for (const seed of seeds) {
    if (seed.token) secrets[`botToken.${seed.id}`] = seed.token
    if (seed.voiceKey) secrets[`voiceKey.${seed.id}`] = seed.voiceKey
    for (const [name, value] of Object.entries(seed.state ?? {})) {
      if (value !== undefined) storage[`tg.${seed.id}.${name}`] = value
    }
  }
  return mockHost({
    capabilities: CAPABILITIES,
    storage,
    secrets,
    settings: { debugLogging: options.debugLogging ?? false }
  })
}

function loggingHost(
  options: {
    debugLogging?: boolean
    storedLogs?: { id: string; at: number; level: string; message: string }[]
  } = {}
) {
  return bridgesHost([{ id: 'b-logtest1', token: REAL_TOKEN }], {
    debugLogging: options.debugLogging,
    ...(options.storedLogs ? { storage: { 'tg.logs': options.storedLogs } } : {})
  })
}

// Logs are written at once.
async function mountBridge(host: MockHost, deps: ReturnType<typeof makeMockDeps>, extra: Partial<BridgeDeps> = {}) {
  return mountController(host, {
    telegram: deps.telegram,
    orcaCli: deps.orcaCli,
    pollIntervalMs: 0,
    logFlushMs: 0,
    ...extra
  })
}

function storedLogs(host: MockHost): BridgeLogEntry[] {
  return host.data().storage['tg.logs'] as BridgeLogEntry[]
}

function failingSendCli() {
  return makeMockDeps({
    orcaCli: {
      async sendToBot() {
        throw new OrcaCliError('orchestration send failed', {
          kind: 'exit',
          args: ['orchestration', 'send', '--to', 'bot:Assistant', '--chat', 'new', '--body-file', '-', '--json'],
          exitCode: 2,
          stderr: 'Error: bot "Assistant" is not running',
          durationMs: 41
        })
      }
    }
  })
}

test('a failing orca CLI call shows its args, exit code and stderr in the panel log', async () => {
  const host = loggingHost()
  const deps = failingSendCli()
  const { manager, controller, worker } = await mountBridge(host, deps)
  try {
    await controller.handleIncomingUpdate(textUpdate(1, 777888, 'Summarize my notes'))
    const entry = manager.getState().logs.find((e) => e.level === 'error')
    assert.ok(entry, 'an error entry is logged')
    assert.equal(entry.scope, 'dispatch')
    assert.match(entry.message, /Failed handling message for Assistant: orchestration send failed/)
    assert.equal(entry.bridgeId, controller.id)
    assert.match(entry.details ?? '', /command: orca orchestration send --to bot:Assistant --chat new/)
    assert.match(entry.details ?? '', /exit code: 2/)
    assert.match(entry.details ?? '', /bot "Assistant" is not running/)
    assert.match(entry.details ?? '', /tgChatId=777888/)
    assert.match(entry.details ?? '', /bot=Assistant/)
    assert.match(entry.details ?? '', /elapsedMs=\d+/)
    // The user is still told it failed.
    assert.equal(deps.sentMessages.at(-1)?.text, t('en').errorOrcaUnreachable)
  } finally {
    await worker.deactivate()
  }
})

test('the bot token never reaches log messages, details, storage, orca.log or the export', async () => {
  const host = loggingHost({ debugLogging: true })
  const deps = makeMockDeps({
    orcaCli: {
      async sendToBot() {
        throw new Error(
          `request https://api.telegram.org/bot123:ABC-def_9/getMe failed; token=${REAL_TOKEN}; url=https://api.telegram.org/bot${REAL_TOKEN}/sendMessage`
        )
      }
    }
  })
  const { manager, controller, worker } = await mountBridge(host, deps)
  try {
    await controller.handleIncomingUpdate(textUpdate(1, 777888, 'hello'))
    const exported = await manager.exportLogs()
    const surfaces = {
      state: JSON.stringify(manager.getState().logs),
      storage: JSON.stringify(storedLogs(host)),
      orcaLog: worker.logs.join('\n'),
      export: exported.text
    }
    for (const [name, text] of Object.entries(surfaces)) {
      assert.ok(!text.includes(REAL_TOKEN), `${name} holds the token`)
      assert.ok(!text.includes(REAL_TOKEN.split(':')[1]), `${name} holds the token secret`)
      assert.ok(!text.includes('bot123:ABC'), `${name} holds a bot<id>:<secret> URL`)
    }
    assert.match(surfaces.state, /bot<redacted>/)
    assert.match(surfaces.export, /bot<redacted>/)
    const reply = deps.sentMessages.at(-1)?.text ?? ''
    assert.equal(reply, t('en').errorGeneric)
    assert.ok(!reply.includes(REAL_TOKEN) && !reply.includes('bot123:ABC'), 'the Telegram reply holds the token')
  } finally {
    await worker.deactivate()
  }
})

test('debug entries are stored only while debug logging is on, and a dispatch then logs its timings', async () => {
  const host = loggingHost()
  const deps = makeMockDeps()
  const { manager, controller, worker } = await mountBridge(host, deps)
  try {
    await controller.handleIncomingUpdate(textUpdate(1, 777888, 'first'))
    assert.equal(deps.sentMessages.at(-1)?.text, 'Reply #1 from Assistant')
    assert.ok(manager.getState().logs.every((e) => e.level !== 'debug'))
    assert.ok(storedLogs(host).every((e) => e.level !== 'debug'))

    const state = (await worker.request('bridge.setDebugLogging', { enabled: true })) as BridgeState
    assert.equal(state.global.debugLogging, true)
    assert.equal(host.data().settings.debugLogging, true)
    assert.equal(state.logs[0].message, 'Debug logging enabled')

    await controller.handleIncomingUpdate(textUpdate(2, 777888, 'second'))
    assert.equal(deps.sentMessages.at(-1)?.text, 'Reply #2 from Assistant')
    const debug = manager.getState().logs.filter((e) => e.level === 'debug').map((e) => e.message)
    assert.ok(
      debug.some((m) => /^Dispatch start: bot Assistant, tg chat 777888, bound Orca chat tg-chat-2, body 6 chars/.test(m)),
      `no dispatch start entry in ${JSON.stringify(debug)}`
    )
    assert.ok(
      debug.some((m) => /^Dispatch finished in \d+ ms: Orca chat tg-chat-2, [1-9]\d* poll\(s\), state done/.test(m)),
      `no dispatch finish entry in ${JSON.stringify(debug)}`
    )
    // The user's text itself is never logged, only its length.
    assert.ok(!JSON.stringify(manager.getState().logs).includes('second'))
  } finally {
    await worker.deactivate()
  }
})

test('a failing typing indicator on an image message is logged as debug and the reply still goes out', async () => {
  const downloadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-tg-bridge-test-'))
  const host = loggingHost({ debugLogging: true })
  const deps = makeMockDeps({
    telegram: {
      async sendChatAction() {
        throw new TelegramApiError('Bad Request: chat not found', 400, false, undefined, 'sendChatAction')
      }
    }
  })
  const { manager, controller, worker } = await mountBridge(host, deps, { downloadDir })
  try {
    await controller.handleIncomingUpdate({
      update_id: 1,
      message: {
        message_id: 21,
        from: { id: 777888, is_bot: false, first_name: 'Demo' },
        chat: { id: 777888, type: 'private' },
        date: 2000,
        photo: [{ file_id: 'photo-lg', file_unique_id: 'lg', width: 1280, height: 720, file_size: 48000 }]
      }
    })
    assert.equal(deps.sentToBots.length, 1)
    assert.equal(deps.sentMessages.at(-1)?.text, 'Reply #1 from Assistant')
    const entry = manager.getState().logs.find((e) => e.message === 'Typing indicator failed for chat 777888')
    assert.ok(entry, 'the swallowed typing failure is recorded')
    assert.equal(entry.level, 'debug')
    assert.match(entry.details ?? '', /TelegramApiError: Bad Request: chat not found/)
    assert.match(entry.details ?? '', /method: sendChatAction/)
    assert.match(entry.details ?? '', /HTTP status: 400/)
  } finally {
    await worker.deactivate()
    await fs.rm(downloadDir, { recursive: true, force: true })
  }
})

test('exported logs carry the diagnostics header and every entry with its details', async () => {
  const host = loggingHost()
  const deps = failingSendCli()
  const { controller, worker } = await mountBridge(host, deps)
  try {
    await controller.handleIncomingUpdate(textUpdate(1, 777888, 'Summarize my notes'))
    const exported = (await worker.request('bridge.exportLogs')) as ExportLogsResult
    assert.match(exported.fileName, /^telegram-bridge-logs-\d{8}-\d{6}\.txt$/)
    const text = exported.text
    assert.match(text, /^Telegram Bridge diagnostics$/m)
    assert.match(text, /^Plugin: .+ (?:\d+\.\d+\.\d+|unknown)$/m)
    assert.match(text, /^Platform: \S+ \S+$/m)
    assert.match(text, /^Node: v\d+/m)
    assert.match(text, /^Orca CLI: \S+/m)
    assert.match(text, /^Bridges: 1$/m)
    assert.match(text, /^Bridge: Bridge 1 \(b-logtest1\)$/m)
    assert.match(text, /^ {2}Status: stopped$/m)
    assert.match(text, /^ {2}Config: .*"hasToken":true/m)
    assert.match(text, /^ {2}Bindings: 1$/m)
    assert.match(text, /^Log entries: \d+$/m)
    assert.match(text, /Z ERROR \[dispatch\] \[Bridge 1\] Failed handling message for Assistant: orchestration send failed\n/)
    assert.match(text, /\n {2}command: orca orchestration send --to bot:Assistant/)
    assert.match(text, /\n {2}exit code: 2\n/)
    assert.ok(!text.includes(REAL_TOKEN))
    // Oldest first: the error comes after the earlier info entry about the incoming message.
    assert.ok(text.indexOf('[TG ') < text.indexOf('ERROR [dispatch]'))
  } finally {
    await worker.deactivate()
  }
})

test('the panel state carries the newest 40 entries while storage keeps at most 200', async () => {
  const old = Array.from({ length: 250 }, (_, i) => ({
    id: `old-${i}`,
    at: 1_000_000 - i,
    level: 'info',
    message: `old entry ${i}`
  }))
  const host = loggingHost({ storedLogs: old })
  const { manager, controller, worker } = await mountBridge(host, makeMockDeps())
  try {
    await controller.allowUserId('5')
    const state = manager.getState()
    assert.equal(state.logs.length, 40)
    assert.equal(state.logTotal, 200)
    assert.equal(state.logs[0].message, 'Added Telegram user 5 to allowlist.')
    assert.equal(storedLogs(host).length, 200)
    const lastPost = worker.posts.filter((p) => p.event === 'bridge.stateChanged').at(-1)?.payload as BridgeState
    assert.ok(lastPost.logs.length <= 40)
    assert.equal((await manager.exportLogs()).text.match(/ \[(?:-|config)\] /g)?.length, 200)
  } finally {
    await worker.deactivate()
  }
})

test('entries stored by 0.2.0 without a scope load into state and export', async () => {
  const old = [
    { id: 'b', at: Date.UTC(2026, 0, 2), level: 'error', message: 'old failure' },
    { id: 'a', at: Date.UTC(2026, 0, 1), level: 'info', message: 'old entry one' }
  ]
  const host = loggingHost({ storedLogs: old })
  const { manager, worker } = await mountBridge(host, makeMockDeps())
  try {
    const state = manager.getState()
    assert.deepEqual(
      state.logs.map((e) => [e.id, e.level, e.scope, e.message]),
      [
        ['b', 'error', undefined, 'old failure'],
        ['a', 'info', undefined, 'old entry one']
      ]
    )
    assert.equal(state.logTotal, 2)
    const text = (await manager.exportLogs()).text
    assert.match(text, /2026-01-01T00:00:00\.000Z INFO \[-\] old entry one\n2026-01-02T00:00:00\.000Z ERROR \[-\] old failure\n/)
  } finally {
    await worker.deactivate()
  }
})

const CJK = /[\u4e00-\u9fff]/

// What a stranger reads after messaging the bot while the allowlist holds only someone else.
async function unauthorizedReply(
  replyLanguage?: string,
  // The stranger's Telegram app language, which Auto follows.
  languageCode?: string
): Promise<{ reply: string; language: string }> {
  const host = mockHost({
    capabilities: CAPABILITIES,
    secrets: { botToken: '123456:TEST_TOKEN' },
    settings: {
      enabled: false,
      defaultBot: 'Assistant',
      allowedUserIds: '42',
      proxyUrl: '',
      replyTimeoutSec: 300,
      ...(replyLanguage === undefined ? {} : { replyLanguage })
    }
  })
  const deps = makeMockDeps()
  const { controller, worker } = await mountController(host, { telegram: deps.telegram, orcaCli: deps.orcaCli })
  try {
    const update = textUpdate(1, 777888, 'hello')
    if (languageCode) update.message!.from!.language_code = languageCode
    await controller.handleIncomingUpdate(update)
    return { reply: deps.sentMessages[0]?.text ?? '', language: controller.view().config.replyLanguage }
  } finally {
    await controller.dispose()
    await worker.deactivate()
  }
}

test('by default the bridge answers a stranger in English with their Telegram ID', async () => {
  const { reply, language } = await unauthorizedReply()
  assert.equal(language, 'en')
  assert.match(reply, /^Not authorized\. Your Telegram ID is 777888\. Ask the bot owner to add it\.$/)
  assert.ok(!CJK.test(reply), `the English reply holds Chinese text: ${reply}`)
})

test('with Portuguese chosen the bridge answers a stranger in Portuguese', async () => {
  const { reply } = await unauthorizedReply('pt-BR')
  assert.match(reply, /^Sem autorização\. Seu ID do Telegram é 777888\./)
})

test('with Chinese chosen the bridge answers a stranger in Chinese', async () => {
  const { reply } = await unauthorizedReply('zh-CN')
  assert.equal(reply, '未获授权。你的 Telegram ID 是 777888，请联系机器人所有者添加。')
})

test('with Spanish chosen the bridge answers a stranger in Spanish', async () => {
  const { reply } = await unauthorizedReply('es')
  assert.match(reply, /^Sin autorización\. Tu ID de Telegram es 777888\./)
})

test("with Auto the bridge answers each stranger in their Telegram app's language, else English", async () => {
  const spanish = await unauthorizedReply('auto', 'es-ES')
  assert.equal(spanish.language, 'auto')
  assert.match(spanish.reply, /^Sin autorización\./)
  assert.match((await unauthorizedReply('auto', 'pt-br')).reply, /^Sem autorização\./)
  assert.match((await unauthorizedReply('auto', 'zh-hans')).reply, /^未获授权/)
  assert.match((await unauthorizedReply('auto', 'de')).reply, /^Not authorized\./)
  assert.match((await unauthorizedReply('auto')).reply, /^Not authorized\./)
})

// Telegram shows each user the menu of their app language, else the default one.
test('Auto sets a command menu per language; a fixed language sets every menu in that language', async () => {
  const menusFor = async (replyLanguage: string) => {
    const host = mockHost({
      capabilities: CAPABILITIES,
      secrets: { botToken: '123456:TEST_TOKEN' },
      settings: { enabled: true, defaultBot: 'Assistant', allowedUserIds: '777888', proxyUrl: '', replyTimeoutSec: 300, replyLanguage }
    })
    // A poll that answers at once would spin the loop on microtasks and starve the test; this one
    // stays open until the bridge stops, as Telegram does while no message arrives.
    const deps = makeMockDeps({
      telegram: {
        getUpdates(_token, _params, options) {
          return new Promise((resolve) => {
            options?.signal?.addEventListener('abort', () => resolve([]), { once: true })
          })
        }
      }
    })
    const { controller, worker } = await within(mountController(host, { telegram: deps.telegram, orcaCli: deps.orcaCli }), 'mount')
    try {
      await until(() => deps.registeredMenus.length === 4, 'four command menus')
      return deps.registeredMenus.map((m) => [m.languageCode, m.commands.find((c) => c.command === 'help')?.description])
    } finally {
      await within(controller.dispose(), 'dispose')
      await worker.deactivate()
    }
  }
  assert.deepEqual(await menusFor('auto'), [
    [null, 'Show available commands'],
    ['pt', 'Mostrar os comandos disponíveis'],
    ['es', 'Mostrar los comandos disponibles'],
    ['zh', t('zh-CN').commands.help]
  ])
  const fixed = await menusFor('es')
  assert.deepEqual(fixed.map(([code]) => code), [null, 'pt', 'es', 'zh'])
  assert.ok(fixed.every(([, help]) => help === 'Mostrar los comandos disponibles'))
})

test("with Auto the Orca bot is told to answer in the user's language; a fixed language says nothing", async () => {
  const bodyFor = async (replyLanguage: string) => {
    const host = mockHost({
      capabilities: CAPABILITIES,
      secrets: { botToken: '123456:TEST_TOKEN' },
      settings: { enabled: false, defaultBot: 'Assistant', allowedUserIds: '777888', proxyUrl: '', replyTimeoutSec: 300, replyLanguage }
    })
    const deps = makeMockDeps()
    const { controller, worker } = await within(
      mountController(host, { telegram: deps.telegram, orcaCli: deps.orcaCli, logFlushMs: 0 }),
      'mount'
    )
    try {
      await within(controller.handleIncomingUpdate(textUpdate(1, 777888, '¿cuál es el saldo?')), 'message')
      return deps.sentToBots[0]?.body ?? ''
    } finally {
      await within(controller.dispose(), 'dispose')
      await worker.deactivate()
    }
  }
  // No language seen yet: English is the fallback the bot is given.
  assert.ok(
    (await bodyFor('auto')).includes(
      "Answer in the language of the user's message; when it has no words (only an image or a file), answer in English."
    )
  )
  assert.equal((await bodyFor('pt-BR')).includes('Answer in the language'), false)
})

test("Auto keeps each chat's language: English until one is seen, then that one, even after a restart", async () => {
  const host = mockHost({
    capabilities: CAPABILITIES,
    secrets: { botToken: '123456:TEST_TOKEN' },
    settings: { enabled: false, defaultBot: 'Assistant', allowedUserIds: '777888, 555', proxyUrl: '', replyTimeoutSec: 300, replyLanguage: 'auto' }
  })
  // A message saying "please fail" makes the bot fail, so the bridge answers with its own text.
  const failingDeps = () => {
    const deps = makeMockDeps()
    const sendToBot = deps.orcaCli.sendToBot
    deps.orcaCli.sendToBot = async (params) => {
      if (params.body.includes('please fail')) throw new Error('bot unavailable')
      return sendToBot(params)
    }
    return deps
  }
  const update = (id: number, userId: number, text: string, languageCode?: string) => {
    const u = textUpdate(id, userId, text)
    if (languageCode) u.message!.from!.language_code = languageCode
    return u
  }
  const lastTo = (deps: ReturnType<typeof makeMockDeps>, chatId: string) =>
    deps.sentMessages.filter((m) => String(m.chatId) === chatId).at(-1)?.text ?? ''
  const run = async (deps: ReturnType<typeof makeMockDeps>, steps: (send: (u: TelegramUpdate) => Promise<void>) => Promise<void>) => {
    const { controller, worker } = await within(
      mountController(host, { telegram: deps.telegram, orcaCli: deps.orcaCli, logFlushMs: 0 }),
      'mount'
    )
    try {
      await steps((u) => within(controller.handleIncomingUpdate(u), `update ${u.update_id}`))
    } finally {
      await within(controller.dispose(), 'dispose')
      await worker.deactivate()
    }
  }

  const first = failingDeps()
  await run(first, async (send) => {
    // Nothing known yet, and no Telegram language: English.
    await send(update(1, 777888, 'please fail'))
    assert.equal(lastTo(first, '777888'), t('en').errorGeneric)
    // A Spanish Telegram app: the chat's language from now on, and the bot is told.
    await send(update(2, 777888, 'hola', 'es'))
    assert.ok(first.sentToBots.at(-1)?.body.includes('answer in Spanish.'))
    // A later message without a Telegram language keeps Spanish.
    await send(update(3, 777888, 'please fail'))
    assert.equal(lastTo(first, '777888'), t('es').errorGeneric)
  })

  const afterRestart = failingDeps()
  await run(afterRestart, async (send) => {
    await send(update(4, 777888, 'please fail'))
    assert.equal(lastTo(afterRestart, '777888'), t('es').errorGeneric)
    // Another chat starts in English.
    await send(update(5, 555, 'please fail'))
    assert.equal(lastTo(afterRestart, '555'), t('en').errorGeneric)
  })
})

test('an unknown stored reply language falls back to English', async () => {
  const { reply, language } = await unauthorizedReply('fr')
  assert.equal(language, 'en')
  assert.match(reply, /^Not authorized\./)
})

test('saving a new reply language sends the Telegram command menu again in that language', async () => {
  const host = mockHost({
    capabilities: CAPABILITIES,
    secrets: { botToken: '123456:TEST_TOKEN' },
    settings: { enabled: true, defaultBot: 'Assistant', allowedUserIds: '777888', proxyUrl: '', replyTimeoutSec: 300 }
  })
  // Each long poll stays open until the test answers it, as Telegram does while no message arrives.
  const polls: PromiseWithResolvers<TelegramUpdate[]>[] = []
  const deps = makeMockDeps({
    telegram: {
      getUpdates(_token, _params, options) {
        const poll = Promise.withResolvers<TelegramUpdate[]>()
        polls.push(poll)
        options?.signal?.addEventListener('abort', () => poll.resolve([]), { once: true })
        return poll.promise
      }
    }
  })
  const { manager, controller, worker } = await mountController(host, { telegram: deps.telegram, orcaCli: deps.orcaCli })
  try {
    await until(() => polls.length === 1, 'the first poll')
    assert.equal(deps.registeredCommands.length, 1)
    assert.equal(deps.registeredCommands[0].find((c) => c.command === 'help')?.description, 'Show available commands')

    await within(
      manager.saveConfig(saveInput(controller, { enabled: true, replyLanguage: 'pt-BR' })),
      'saveConfig with a new language'
    )
    polls[0].resolve([])
    await until(() => deps.registeredCommands.length === 2, 'the command menu in Portuguese')

    const [english, portuguese] = deps.registeredCommands
    assert.deepEqual(
      portuguese.map((c) => c.command),
      english.map((c) => c.command)
    )
    assert.equal(portuguese.find((c) => c.command === 'help')?.description, 'Mostrar os comandos disponíveis')
    assert.equal(controller.view().config.replyLanguage, 'pt-BR')
  } finally {
    await controller.dispose()
    await worker.deactivate()
  }
})

test('a reply that Orca shortened ends with the note in the chosen language', async () => {
  const host = mockHost({
    capabilities: CAPABILITIES,
    secrets: { botToken: '123456:TEST_TOKEN' },
    settings: {
      enabled: false,
      defaultBot: 'Assistant',
      allowedUserIds: '777888',
      proxyUrl: '',
      replyTimeoutSec: 300,
      replyLanguage: 'pt-BR'
    }
  })
  const deps = makeMockDeps()
  const baseReadSession = deps.orcaCli.readSession
  deps.orcaCli.readSession = async (sessionId, limit) => {
    const session = await baseReadSession(sessionId, limit)
    return {
      ...session,
      entries: session.entries.map((e) => (e.role === 'assistant' ? { ...e, shortened: true } : e))
    }
  }
  const { controller, worker } = await mountController(host, {
    telegram: deps.telegram,
    orcaCli: deps.orcaCli,
    pollIntervalMs: 1
  })
  try {
    await controller.handleIncomingUpdate(textUpdate(1, 777888, 'Write the full report'))
    const reply = deps.sentMessages.at(-1)?.text ?? ''
    assert.ok(reply.startsWith('Reply #1 from Assistant'), reply)
    assert.ok(
      reply.endsWith('(A resposta era longa demais e foi encurtada. Abra o Orca para ver o texto completo.)'),
      reply
    )
    assert.ok(!CJK.test(reply), `the Portuguese reply holds Chinese text: ${reply}`)
  } finally {
    await controller.dispose()
    await worker.deactivate()
  }
})

// The bot that makeMockDeps' getMe reports.
const BOT_USER = { id: 100000001, is_bot: true, first_name: 'DemoBot', username: 'demo_orca_bot' }
const GROUP_ID = -100500

function groupUpdate(
  updateId: number,
  userId: number,
  text: string,
  extra: Partial<TelegramMessage> = {}
): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: 100 + updateId,
      from: { id: userId, is_bot: false, first_name: 'Member' },
      chat: { id: GROUP_ID, type: 'supergroup', title: 'Team' },
      date: 1000,
      text,
      ...extra
    }
  }
}

// Mounts the bridge with this allowlist. testConnection runs getMe, so the bot knows its @username
// and user id the way it does once polling starts.
async function withAccess(
  allowedUserIds: string,
  run: (controller: BridgeRuntime, deps: ReturnType<typeof makeMockDeps>, manager: BridgeManager) => Promise<void>
): Promise<void> {
  const host = mockHost({
    capabilities: CAPABILITIES,
    secrets: { botToken: '123456:TEST_TOKEN' },
    settings: { enabled: false, defaultBot: 'Assistant', allowedUserIds, proxyUrl: '', replyTimeoutSec: 300 }
  })
  const deps = makeMockDeps()
  const { manager, controller, worker } = await mountController(host, {
    telegram: deps.telegram,
    orcaCli: deps.orcaCli,
    pollIntervalMs: 1
  })
  try {
    await controller.testConnection()
    await run(controller, deps, manager)
    assert.deepEqual(worker.refusals, [])
  } finally {
    await controller.dispose()
    await worker.deactivate()
  }
}

// The user's own words are the last line of the body the Orca bot receives.
function lastBodyLine(deps: ReturnType<typeof makeMockDeps>): string {
  return deps.sentToBots.at(-1)?.body.split('\n').at(-1) ?? ''
}

test('with an empty allowlist a stranger reaches the Orca bot and gets no access-denied reply', async () => {
  await withAccess('', async (controller, deps) => {
    await controller.handleIncomingUpdate(textUpdate(1, 777888, 'hello there'))
    assert.equal(deps.sentToBots.length, 1)
    assert.equal(lastBodyLine(deps), 'hello there')
    assert.ok(!deps.sentMessages.some((m) => m.text === t('en').unauthorized('777888')))
    assert.equal(controller.view().lastBlockedUserId, null)
  })
})

test('with a restricted allowlist a stranger is blocked and told only once, however often they write', async () => {
  await withAccess('42', async (controller, deps) => {
    for (let i = 1; i <= 3; i++) {
      await controller.handleIncomingUpdate(textUpdate(i, 777888, `hello ${i}`))
    }
    assert.equal(deps.sentToBots.length, 0)
    assert.deepEqual(
      deps.sentMessages.map((m) => m.text),
      [t('en').unauthorized('777888')]
    )
    assert.equal(controller.view().lastBlockedUserId, '777888')
  })
})

test('restricted with an empty list blocks everyone until the owner allows the blocked ID', async () => {
  await withAccess('', async (controller, deps, manager) => {
    await manager.saveConfig(saveInput(controller, { restricted: true, allowedUserIds: '' }))
    assert.equal(controller.view().config.restricted, true)
    await controller.handleIncomingUpdate(textUpdate(1, 777888, 'hi'))
    assert.equal(deps.sentToBots.length, 0)
    assert.equal(deps.sentMessages[0]?.text, t('en').unauthorized('777888'))
    assert.equal(controller.view().lastBlockedUserId, '777888')

    await controller.allowUserId('777888')
    assert.equal(controller.view().config.allowedUserIds, '777888')
    await controller.handleIncomingUpdate(textUpdate(2, 777888, 'hello again'))
    assert.equal(deps.sentToBots.length, 1)
    assert.equal(lastBodyLine(deps), 'hello again')
  })
})

test('a listed group lets an unlisted member reach the Orca bot by mentioning it', async () => {
  await withAccess(String(GROUP_ID), async (controller, deps) => {
    await controller.handleIncomingUpdate(
      groupUpdate(1, 555, 'hi @Demo_Orca_Bot, any news?', {
        entities: [{ type: 'mention', offset: 3, length: 14 }]
      })
    )
    assert.equal(deps.sentToBots.length, 1)
    assert.equal(lastBodyLine(deps), 'hi, any news?')
    assert.equal(controller.view().lastBlockedUserId, null)
  })
})

test('a group message that neither mentions nor replies to the bot is ignored', async () => {
  await withAccess('', async (controller, deps) => {
    await controller.handleIncomingUpdate(groupUpdate(1, 555, 'just chatting with the team'))
    await controller.handleIncomingUpdate(
      groupUpdate(2, 555, 'agreed', {
        reply_to_message: {
          message_id: 50,
          from: { id: 556, is_bot: false, first_name: 'Other' },
          chat: { id: GROUP_ID, type: 'supergroup' },
          date: 999,
          text: 'shall we ship?'
        }
      })
    )
    assert.equal(deps.sentToBots.length, 0)
    assert.equal(deps.sentMessages.length, 0)
    assert.equal(controller.view().lastBlockedUserId, null)
  })
})

test('a plain-text @mention reaches the Orca bot without the mention', async () => {
  await withAccess('', async (controller, deps) => {
    await controller.handleIncomingUpdate(groupUpdate(1, 555, '@demo_orca_bot what is up'))
    assert.equal(deps.sentToBots.length, 1)
    assert.equal(lastBodyLine(deps), 'what is up')
    assert.ok(!deps.sentToBots[0].body.includes('demo_orca_bot'))
  })
})

test('a group reply to a message from the bot reaches the Orca bot', async () => {
  await withAccess('', async (controller, deps) => {
    await controller.handleIncomingUpdate(
      groupUpdate(1, 555, 'and tomorrow?', {
        reply_to_message: {
          message_id: 901,
          from: BOT_USER,
          chat: { id: GROUP_ID, type: 'supergroup' },
          date: 999,
          text: 'Reply #1 from Assistant'
        }
      })
    )
    assert.equal(deps.sentToBots.length, 1)
    assert.equal(lastBodyLine(deps), 'and tomorrow?')
  })
})

test('group commands for this bot run without a mention; commands for another bot are ignored', async () => {
  await withAccess('', async (controller, deps) => {
    await controller.handleIncomingUpdate(groupUpdate(1, 555, '/help@other_bot'))
    assert.equal(deps.sentMessages.length, 0)
    await controller.handleIncomingUpdate(groupUpdate(2, 555, '/help@demo_orca_bot'))
    await controller.handleIncomingUpdate(groupUpdate(3, 555, '/start'))
    assert.equal(deps.sentMessages.length, 2)
    assert.ok(deps.sentMessages.every((m) => String(m.chatId) === String(GROUP_ID)))
    assert.equal(deps.sentToBots.length, 0)
  })
})

test('a restricted allowlist holding only a group id still blocks a stranger in a private chat', async () => {
  await withAccess(String(GROUP_ID), async (controller, deps) => {
    await controller.handleIncomingUpdate(textUpdate(1, 777888, 'hello'))
    assert.equal(deps.sentToBots.length, 0)
    assert.equal(controller.view().lastBlockedUserId, '777888')
    assert.equal(deps.sentMessages[0]?.text, t('en').unauthorized('777888'))
  })
})

test('outbound sync forwards nothing while the allowlist is empty', async () => {
  const session: OrcaSessionRead = {
    orcaSessionId: 'orca-bound',
    state: 'done',
    entries: [{ kind: 'message', role: 'assistant', text: 'Old history' }]
  }
  let activityAt = 1000
  const host = mockHost({
    capabilities: CAPABILITIES,
    secrets: { botToken: '123456:TEST_TOKEN' },
    settings: {
      enabled: false,
      defaultBot: 'Assistant',
      allowedUserIds: '',
      proxyUrl: '',
      replyTimeoutSec: 300,
      syncOrcaOutbound: true
    },
    storage: {
      'tg.bindings': [
        { tgChatId: '777888', ownerUserId: '777888', botId: 'bot-1', botName: 'Assistant', orcaChatId: 'orca-bound', updatedAt: 1000 }
      ]
    }
  })
  const deps = makeMockDeps({
    orcaCli: {
      async listBotChats() {
        return [
          {
            id: 'orca-bound',
            title: 'Bound',
            lastActivityAt: activityAt,
            lastAsked: null,
            lastSaid: null,
            home: false,
            self: false,
            closed: false
          }
        ]
      },
      async readSession() {
        return { ...session, entries: [...session.entries] }
      }
    }
  })
  const { controller, worker } = await mountController(host, { telegram: deps.telegram, orcaCli: deps.orcaCli })
  try {
    await controller.syncOrcaBoundChatsOnce()
    activityAt = 2000
    session.entries.push({ kind: 'message', role: 'user', text: 'Private Orca-side question' })
    session.entries.push({ kind: 'message', role: 'assistant', text: 'Private Orca-side answer' })
    await controller.syncOrcaBoundChatsOnce()
    assert.equal(deps.sentMessages.length, 0)
  } finally {
    await controller.dispose()
    await worker.deactivate()
  }
})

async function withPolling(
  enabled: boolean,
  run: (
    controller: BridgeRuntime,
    host: MockHost,
    deps: ReturnType<typeof makeMockDeps>,
    manager: BridgeManager
  ) => Promise<void>,
  orcaCli: Partial<OrcaCliRunner> = {}
): Promise<void> {
  const host = mockHost({
    capabilities: CAPABILITIES,
    secrets: { botToken: '123456:TEST_TOKEN' },
    settings: { enabled, defaultBot: 'Assistant', allowedUserIds: '42', proxyUrl: '', replyTimeoutSec: 300 }
  })
  const deps = makeMockDeps({ orcaCli })
  const { manager, controller, worker } = await mountController(host, {
    telegram: deps.telegram,
    orcaCli: deps.orcaCli,
    pollIntervalMs: 1
  })
  try {
    await run(controller, host, deps, manager)
    assert.deepEqual(worker.refusals, [])
  } finally {
    await within(controller.dispose(), 'dispose')
    await worker.deactivate()
  }
}

test('the open-panel command opens this plugin panel by its manifest key', async () => {
  await withPolling(false, async (_controller, _host, deps, manager) => {
    assert.equal(await manager.openPanel(), 'Telegram panel opened')
    assert.deepEqual(deps.openedPanels, [{ pluginKey: 'drecchia.telegram-bridge', panelId: 'telegram-bridge' }])
  })
})

test('a failed open-panel command is logged as a warning and answered, not thrown', async () => {
  await withPolling(
    false,
    async (_controller, _host, _deps, manager) => {
      const answer = await manager.openPanel()
      assert.match(answer, /no_workspace/)
      assert.match(answer, /Open a workspace in Orca first/)
      const entry = manager.getState().logs.find((e) => e.level === 'warn' && e.scope === 'orca-cli')
      assert.ok(entry, 'warn log entry')
      assert.match(entry.message, /Failed to open the Telegram panel/)
    },
    {
      async openPanel() {
        throw new Error('no_workspace: no workspace is showing')
      }
    }
  )
})

function storedBridges(host: MockHost): { id: string; name: string; enabled: boolean }[] {
  return host.data().storage.bridges as { id: string; name: string; enabled: boolean }[]
}

test('setEnabled stops and starts polling at once and repeating a value changes nothing', async () => {
  await withPolling(true, async (controller, host) => {
    await until(() => controller.view().polling, 'polling to start')

    await within(controller.setEnabled(false), 'setEnabled(false)')
    assert.equal(controller.view().polling, false)
    assert.equal(controller.view().status, 'stopped')
    assert.equal(storedBridges(host)[0].enabled, false)

    await within(controller.setEnabled(false), 'setEnabled(false) again')
    assert.equal(controller.view().config.enabled, false)
    assert.equal(controller.view().polling, false)

    await within(controller.setEnabled(true), 'setEnabled(true)')
    assert.equal(controller.view().config.enabled, true)
    assert.equal(controller.view().polling, true)
    assert.equal(storedBridges(host)[0].enabled, true)

    await within(controller.setEnabled(true), 'setEnabled(true) again')
    assert.equal(controller.view().config.enabled, true)
    assert.equal(controller.view().polling, true)
  })
})

test('saving settings without the enabled field keeps polling running', async () => {
  await withPolling(true, async (controller, host, _deps, manager) => {
    await until(() => controller.view().polling, 'polling to start')
    await within(manager.saveConfig(saveInput(controller, { allowedUserIds: '42, 43' })), 'saveConfig')
    assert.equal(controller.view().config.enabled, true)
    assert.equal(controller.view().polling, true)
    assert.equal(storedBridges(host)[0].enabled, true)
  })
})

test('a stranger blocked in two groups is logged once per group', async () => {
  await withAccess('42', async (controller, _deps, manager) => {
    const otherGroup: Partial<TelegramMessage> = { chat: { id: -100600, type: 'supergroup', title: 'Other' } }
    await controller.handleIncomingUpdate(groupUpdate(1, 777, '@demo_orca_bot hi'))
    await controller.handleIncomingUpdate(groupUpdate(2, 777, '@demo_orca_bot hi', otherGroup))
    await controller.handleIncomingUpdate(groupUpdate(3, 777, '@demo_orca_bot again'))
    const warns = manager.getState().logs.filter((e) => e.level === 'warn').map((e) => e.message)
    assert.equal(warns.filter((m) => m.includes('in group -100500')).length, 1)
    assert.equal(warns.filter((m) => m.includes('in group -100600')).length, 1)
  })
})

test('a 0.4.0 setup becomes "Bridge 1" with its token, settings, chats and offset, and the old keys go', async () => {
  const legacyBinding = {
    tgChatId: '777888',
    ownerUserId: '777888',
    botId: 'bot-2',
    botName: 'Daily standup notes',
    orcaChatId: 'orca-old',
    updatedAt: 1000
  }
  const legacyCursors = { 'orca-old': { tailHashes: ['h1'], lastActivityAt: 1000, pendingWorking: false } }
  const host = mockHost({
    capabilities: CAPABILITIES,
    secrets: { botToken: '123456:LEGACY' },
    settings: {
      enabled: true,
      defaultBot: 'Daily standup notes',
      allowedUserIds: '777888',
      proxyUrl: '',
      replyTimeoutSec: 240,
      syncOrcaOutbound: true,
      replyLanguage: 'pt-BR'
    },
    storage: {
      'tg.updateOffset': 77,
      'tg.bindings': [legacyBinding],
      'tg.syncCursors': legacyCursors,
      'tg.lastBlockedUserId': '999'
    }
  })
  const polls: { token: string; offset: number | undefined }[] = []
  const deps = makeMockDeps({
    telegram: { getUpdates: scriptedGetUpdates([], (token, offset) => polls.push({ token, offset })) }
  })
  const { controller, worker } = await mountController(host, { telegram: deps.telegram, orcaCli: deps.orcaCli })
  try {
    // Polling resumes where 0.4.0 stopped: an offset of 0 would replay or drop pending updates.
    await until(() => polls.length > 0, 'the first poll of Bridge 1')
    assert.deepEqual(polls[0], { token: '123456:LEGACY', offset: 77 })

    const view = controller.view()
    assert.match(view.id, /^b-[a-z0-9]{8}$/)
    assert.deepEqual(view.config, {
      id: view.id,
      name: 'Bridge 1',
      hasToken: true,
      enabled: true,
      orcaBot: 'Daily standup notes',
      restricted: true,
      allowedUserIds: '777888',
      // Roles did not exist in 0.4.0: everyone allowed keeps full access until the owner reviews.
      roles: defaultRoles(),
      roleAssignments: { '777888': 'full' },
      rolesReviewed: false,
      groupAuditNotice: false,
      proxyUrl: '',
      replyTimeoutSec: 240,
      syncOrcaOutbound: true,
      replyLanguage: 'pt-BR',
      // 0.4.0 answered in groups; the update keeps that.
      allowGroups: true,
      groupMode: 'addressed',
      groupReply: 'mentioned',
      // Voice did not exist in 0.4.0: off, provider default, no key.
      voiceEnabled: false,
      voiceProvider: 'openrouter',
      voiceModel: '',
      hasVoiceKey: false
    })
    assert.equal(view.lastBlockedUserId, '999')
    assert.deepEqual(view.bindings, [legacyBinding])

    const { storage, secrets } = host.data()
    assert.equal(secrets.botToken, undefined)
    assert.equal(secrets[`botToken.${view.id}`], '123456:LEGACY')
    assert.deepEqual(storage[`tg.${view.id}.syncCursors`], legacyCursors)
    for (const key of ['tg.updateOffset', 'tg.bindings', 'tg.syncCursors', 'tg.lastBlockedUserId', 'migration.bridgeId']) {
      assert.equal(storage[key], undefined, `${key} is left behind`)
    }
    assert.deepEqual(storedBridges(host).map((b) => b.id), [view.id])
    assert.deepEqual(worker.refusals, [])
  } finally {
    await worker.deactivate()
  }
})

test('a 0.4.0 bot that was paused stays paused as Bridge 1', async () => {
  const host = mockHost({
    capabilities: CAPABILITIES,
    secrets: { botToken: '123456:LEGACY' },
    settings: { enabled: false, defaultBot: 'Assistant', allowedUserIds: '777888', proxyUrl: '', replyTimeoutSec: 300 }
  })
  let polled = false
  const deps = makeMockDeps({ telegram: { getUpdates: scriptedGetUpdates([], () => (polled = true)) } })
  const { controller, worker } = await mountController(host, { telegram: deps.telegram, orcaCli: deps.orcaCli })
  try {
    assert.equal(controller.view().config.enabled, false)
    assert.equal(controller.view().config.hasToken, true)
    assert.equal(controller.view().status, 'stopped')
    assert.equal(controller.view().polling, false)
    assert.equal(polled, false)
  } finally {
    await worker.deactivate()
  }
})

test('a migration cut short after copying resumes with the same bridge and keeps the token', async () => {
  const binding = { tgChatId: '777888', botId: 'bot-1', botName: 'Assistant', orcaChatId: 'orca-1', updatedAt: 1000 }
  // The worker stopped after step 1: the copies exist, `bridges` and the old keys' deletion do not.
  const host = mockHost({
    capabilities: CAPABILITIES,
    secrets: { botToken: '123456:LEGACY', 'botToken.b-resume01': '123456:LEGACY' },
    settings: { enabled: true, defaultBot: 'Assistant', allowedUserIds: '777888', proxyUrl: '', replyTimeoutSec: 300 },
    storage: {
      'migration.bridgeId': 'b-resume01',
      'tg.updateOffset': 5,
      'tg.bindings': [binding],
      'tg.b-resume01.offset': 5,
      'tg.b-resume01.bindings': [binding]
    }
  })
  const deps = makeMockDeps({ telegram: { getUpdates: scriptedGetUpdates([]) } })
  // A second start must find the finished migration, not run it again.
  for (const start of [1, 2]) {
    const { worker } = await mountController(host, { telegram: deps.telegram, orcaCli: deps.orcaCli })
    try {
      const state = (await worker.request('bridge.getState')) as BridgeState
      assert.deepEqual(
        state.bridges.map((b) => [b.id, b.name, b.config.hasToken, b.bindings.length]),
        [['b-resume01', 'Bridge 1', true, 1]],
        `start ${start}`
      )
    } finally {
      await worker.deactivate()
    }
  }
  const { storage, secrets } = host.data()
  assert.equal(secrets['botToken.b-resume01'], '123456:LEGACY')
  assert.equal(secrets.botToken, undefined)
  assert.equal(storage['migration.bridgeId'], undefined)
  assert.equal(storage['tg.bindings'], undefined)
  assert.equal(storage['tg.updateOffset'], undefined)
  assert.deepEqual(storedBridges(host).map((b) => b.id), ['b-resume01'])
})

// Telegram as several bots see it: each token has its own @username and its own updates. A token
// not listed, or one with `rejectWith`, is refused. `openPolls` counts long polls still waiting.
function multiBotTelegram(
  bots: Record<string, { username: string; batches?: TelegramUpdate[][]; rejectWith?: Error }>
) {
  // The first poll answers at once (with `batches[0]`, or nothing), so the bridge turns connected.
  const scripts = new Map(
    Object.entries(bots).map(([token, bot]) => [token, scriptedGetUpdates(bot.batches ?? [[]])])
  )
  const openPolls: Record<string, number> = {}
  const telegram: Partial<TelegramClient> = {
    async getMe(token) {
      const bot = bots[token]
      if (!bot) throw new TelegramApiError('Unauthorized', 401)
      if (bot.rejectWith) throw bot.rejectWith
      return { id: Number(token.split(':')[0]), is_bot: true, first_name: bot.username, username: bot.username }
    },
    async getUpdates(token, params, options) {
      const script = scripts.get(token)
      if (!script) throw new TelegramApiError('Unauthorized', 401)
      openPolls[token] = (openPolls[token] ?? 0) + 1
      try {
        return await script(token, params, options)
      } finally {
        openPolls[token]--
      }
    }
  }
  return { telegram, openPolls }
}

test('two bridges run at once and each Telegram bot reaches only its own Orca bot', async () => {
  const host = bridgesHost([
    { id: 'b-ci000001', token: '111:CI', config: { enabled: true, orcaBot: 'Assistant' } },
    { id: 'b-dev00001', token: '222:DEV', config: { enabled: true, orcaBot: 'Daily standup notes' } }
  ])
  // The same person writes to both Telegram bots.
  const tg = multiBotTelegram({
    '111:CI': { username: 'ci_bot', batches: [[textUpdate(1, 777888, 'build status?')]] },
    '222:DEV': { username: 'dev_bot', batches: [[textUpdate(1, 777888, 'standup?')]] }
  })
  const deps = makeMockDeps({ telegram: tg.telegram })
  const bothReplied = Promise.withResolvers<void>()
  const baseSendMessage = deps.telegram.sendMessage
  deps.telegram.sendMessage = async (token, params, options) => {
    const sent = await baseSendMessage(token, params, options)
    if (deps.sentMessages.length === 2) bothReplied.resolve()
    return sent
  }
  const { manager, worker } = await mountController(host, {
    telegram: deps.telegram,
    orcaCli: deps.orcaCli,
    pollIntervalMs: 1
  })
  try {
    await within(bothReplied.promise, 'a reply from each Telegram bot')
    assert.deepEqual(
      Object.fromEntries(deps.sentToBots.map((s) => [s.body.split('\n').at(-1) ?? '', s.botName])),
      { 'build status?': 'Assistant', 'standup?': 'Daily standup notes' }
    )
    assert.deepEqual(Object.fromEntries(deps.sentMessages.map((m) => [m.token, m.text])), {
      '111:CI': 'Reply #1 from Assistant',
      '222:DEV': 'Reply #1 from Daily standup notes'
    })
    assert.equal(manager.bridge('b-ci000001').view().bindings[0].botName, 'Assistant')
    assert.equal(manager.bridge('b-dev00001').view().bindings[0].botName, 'Daily standup notes')
    assert.deepEqual(worker.refusals, [])
  } finally {
    await worker.deactivate()
  }
})

test('changing the Orca bot of a bridge sends its chats to the new bot in a fresh Orca chat', async () => {
  const host = bridgesHost([
    {
      id: 'b-pin00001',
      token: '111:A',
      state: {
        bindings: [
          { tgChatId: '777888', ownerUserId: '777888', botId: 'bot-1', botName: 'Assistant', orcaChatId: 'orca-a', updatedAt: 1000 }
        ]
      }
    }
  ])
  const deps = makeMockDeps()
  const { manager, controller, worker } = await mountController(host, {
    telegram: deps.telegram,
    orcaCli: deps.orcaCli,
    pollIntervalMs: 1
  })
  try {
    await manager.saveConfig(saveInput(controller, { orcaBot: 'Daily standup notes' }))
    await controller.handleIncomingUpdate(textUpdate(1, 777888, 'hello'))
    assert.deepEqual(
      deps.sentToBots.map((s) => [s.botName, s.chatId]),
      [['Daily standup notes', 'new']]
    )
    assert.equal(controller.view().bindings[0].botName, 'Daily standup notes')
    assert.equal(controller.view().bindings[0].botId, 'bot-2')
  } finally {
    await worker.deactivate()
  }
})

test('a bot token that another bridge uses is refused and not stored', async () => {
  const host = bridgesHost([{ id: 'b-first001', token: '111:SAME' }, { id: 'b-second01' }])
  const deps = makeMockDeps()
  const { manager, worker } = await mountController(host, { telegram: deps.telegram, orcaCli: deps.orcaCli })
  try {
    await assert.rejects(
      worker.request('bridge.saveConfig', saveInput(manager.bridge('b-second01'), { botToken: ' 111:SAME ' })),
      /already used by the bridge "Bridge 1"/
    )
    assert.equal(host.data().secrets['botToken.b-second01'], undefined)
    assert.equal(manager.bridge('b-second01').view().config.hasToken, false)
    assert.equal(manager.bridge('b-first001').view().config.hasToken, true)
  } finally {
    await worker.deactivate()
  }
})

test('adding a bridge creates one switched off, without a token, named by its place', async () => {
  const host = bridgesHost([{ id: 'b-first001', token: '111:A' }])
  const deps = makeMockDeps()
  const { worker } = await mountController(host, { telegram: deps.telegram, orcaCli: deps.orcaCli })
  try {
    const added = (await worker.request('bridge.add', {})) as { bridgeId: string; state: BridgeState }
    assert.match(added.bridgeId, /^b-[a-z0-9]{8}$/)
    const bridge = added.state.bridges.find((b) => b.id === added.bridgeId)
    assert.equal(bridge?.name, 'Bridge 2')
    assert.equal(bridge?.status, 'needs_token')
    assert.equal(bridge?.config.enabled, false)
    assert.equal(bridge?.config.hasToken, false)
    // A new bridge stays out of groups until the owner allows them.
    assert.equal(bridge?.config.allowGroups, false)
    assert.equal(bridge?.config.groupMode, 'addressed')

    const named = (await worker.request('bridge.add', { name: 'Dev bot' })) as { bridgeId: string; state: BridgeState }
    assert.deepEqual(
      named.state.bridges.map((b) => b.name),
      ['Bridge 1', 'Bridge 2', 'Dev bot']
    )
    assert.deepEqual(storedBridges(host).map((b) => b.name), ['Bridge 1', 'Bridge 2', 'Dev bot'])
  } finally {
    await worker.deactivate()
  }
})

test('a second bridge for the same Orca bot is refused on add and on save', async () => {
  const host = bridgesHost([
    { id: 'b-first001', config: { orcaBot: 'Assistant' } },
    { id: 'b-second01', config: { orcaBot: 'CIWatcher' } },
    // Stored before one bridge per bot: it shares Assistant and still saves while it stays there.
    { id: 'b-third001', config: { orcaBot: 'Assistant' } }
  ])
  const deps = makeMockDeps()
  const { manager, worker } = await mountController(host, { telegram: deps.telegram, orcaCli: deps.orcaCli })
  try {
    await assert.rejects(
      worker.request('bridge.add', { orcaBot: ' Assistant ' }),
      /The Orca bot "Assistant" already has a Telegram bridge \("Bridge 1"\)/
    )
    assert.equal(manager.bridges.length, 3)
    await assert.rejects(
      worker.request('bridge.saveConfig', saveInput(manager.bridge('b-second01'), { orcaBot: 'Assistant' })),
      /The Orca bot "Assistant" already has a Telegram bridge/
    )
    assert.equal(manager.bridge('b-second01').orcaBot, 'CIWatcher')
    await worker.request('bridge.saveConfig', saveInput(manager.bridge('b-third001'), { proxyUrl: 'http://127.0.0.1:1' }))

    // A bot without a bridge gets one pinned to it; '' (the first Orca bot) is no name and never conflicts.
    const added = await worker.request('bridge.add', { orcaBot: 'DevHelper' })
    assert.equal(added.state.bridges.find((b) => b.id === added.bridgeId)?.config.orcaBot, 'DevHelper')
    await worker.request('bridge.saveConfig', saveInput(manager.bridge('b-second01'), { orcaBot: '' }))
    await worker.request('bridge.add', {})
    assert.deepEqual(
      manager.bridges.map((b) => b.orcaBot),
      ['Assistant', '', 'Assistant', 'DevHelper', '']
    )
  } finally {
    await worker.deactivate()
  }
})

function focusContext(workspaceId?: string) {
  return { ...(workspaceId ? { workspaceId } : {}), branch: '', displayName: '', terminals: [] }
}

function workspaceRow(id: string, kind: 'folder' | 'worktree', dir: string) {
  return { id, kind, name: path.basename(dir), path: dir, branch: kind === 'worktree' ? 'main' : null, hostId: 'local' }
}

// A host with no bridges whose Orca answers `results` (the focus and the workspace list).
async function mountFocus(results: Record<string, unknown>, capabilities = [...CAPABILITIES, 'workspace:read']) {
  const host = mockHost({ capabilities, storage: { bridges: [] }, results })
  const deps = makeMockDeps()
  const mounted = await mountController(host, { telegram: deps.telegram, orcaCli: deps.orcaCli, logFlushMs: 0 })
  return { host, ...mounted }
}

test("bridge.focusedBot finds the bot whose home folder holds bot.json, else none; the list is asked once", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-focus-'))
  const folder = async (name: string, botJson?: string) => {
    const dir = path.join(root, name)
    await fs.mkdir(dir)
    if (botJson !== undefined) await fs.writeFile(path.join(dir, 'bot.json'), botJson)
    return dir
  }
  const rows = [
    workspaceRow('folder:home', 'folder', await folder('assistant', JSON.stringify({ id: 'bot-1', name: 'Assistant', agent: 'claude' }))),
    // A worktree is never a bot's home, even holding a bot.json.
    workspaceRow('wt:repo', 'worktree', await folder('repo', JSON.stringify({ id: 'bot-9', name: 'Copied' }))),
    workspaceRow('folder:project', 'folder', await folder('project')),
    workspaceRow('folder:broken', 'folder', await folder('broken', '{ not json')),
    workspaceRow('folder:nameless', 'folder', await folder('nameless', JSON.stringify({ id: 'bot-2' })))
  ]
  let focused: string | null = 'folder:home'
  const { host, worker } = await mountFocus({
    'workspace.readContext': () => (focused === null ? null : focusContext(focused)),
    'workspace.list': { workspaces: rows, truncated: false }
  })
  try {
    assert.deepEqual(await worker.request('bridge.focusedBot'), {
      kind: 'bot',
      bot: { id: 'bot-1', name: 'Assistant' }
    })
    for (const id of ['wt:repo', 'folder:project', 'folder:broken', 'folder:nameless']) {
      focused = id
      assert.deepEqual(await worker.request('bridge.focusedBot'), { kind: 'none' }, id)
    }
    focused = null
    assert.deepEqual(await worker.request('bridge.focusedBot'), { kind: 'none' })
    // Clicking through the sidebar reuses the list for a few seconds.
    assert.equal(host.callsOf('workspace.list').length, 1)
    assert.deepEqual(worker.refusals, [])
  } finally {
    await worker.deactivate()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('bridge.focusedBot answers unknown when the lookup cannot run, and warns once per reason', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-focus-'))
  // bot.json is a folder here: unreadable for another reason than missing.
  const odd = path.join(root, 'odd')
  await fs.mkdir(path.join(odd, 'bot.json'), { recursive: true })
  const cases: { label: string; results: Record<string, unknown>; capabilities?: string[] }[] = [
    { label: 'workspace:read refused', results: {}, capabilities: CAPABILITIES },
    { label: 'no workspaceId', results: { 'workspace.readContext': focusContext() } },
    {
      label: 'list fails',
      results: {
        'workspace.readContext': focusContext('folder:odd'),
        'workspace.list': () => {
          throw hostError('unavailable', 'list down')
        }
      }
    },
    {
      label: 'focus not listed',
      results: {
        'workspace.readContext': focusContext('folder:gone'),
        'workspace.list': { workspaces: [], truncated: false }
      }
    },
    {
      label: 'bot.json unreadable',
      results: {
        'workspace.readContext': focusContext('folder:odd'),
        'workspace.list': { workspaces: [workspaceRow('folder:odd', 'folder', odd)], truncated: false }
      }
    }
  ]
  try {
    for (const { label, results, capabilities } of cases) {
      const { host, manager, worker } = await mountFocus(results, capabilities)
      try {
        const first = await worker.request('bridge.focusedBot')
        assert.equal(first.kind, 'unknown', label)
        assert.deepEqual(await worker.request('bridge.focusedBot'), first, label)
        const warnings = manager
          .getState()
          .logs.filter((e) => e.level === 'warn' && e.message.includes('Cannot tell which Orca bot is selected'))
        assert.equal(warnings.length, 1, label)
        // A failed list is not cached: the next focus change asks Orca again.
        if (label === 'list fails') assert.equal(host.callsOf('workspace.list').length, 2)
      } finally {
        await worker.deactivate()
      }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('removing a bridge stops its polling and deletes its token and state; the other keeps polling', async () => {
  const host = bridgesHost([
    { id: 'b-keep0001', token: '111:KEEP', config: { enabled: true } },
    {
      id: 'b-drop0001',
      token: '222:DROP',
      config: { enabled: true },
      state: {
        offset: 9,
        lastBlocked: '5',
        knownNames: { '777888': '@drop_owner' },
        bindings: [{ tgChatId: '777888', botId: 'bot-1', botName: 'Assistant', orcaChatId: 'orca-1', updatedAt: 1000 }]
      }
    }
  ])
  const tg = multiBotTelegram({ '111:KEEP': { username: 'keep_bot' }, '222:DROP': { username: 'drop_bot' } })
  const deps = makeMockDeps({ telegram: tg.telegram })
  const { manager, worker } = await mountController(host, { telegram: deps.telegram, orcaCli: deps.orcaCli })
  try {
    await until(() => tg.openPolls['111:KEEP'] === 1 && tg.openPolls['222:DROP'] === 1, 'both bridges long-polling')
    assert.deepEqual(manager.bridge('b-drop0001').view().knownNames, { '777888': '@drop_owner' })
    const state = (await within(worker.request('bridge.remove', { bridgeId: 'b-drop0001' }), 'remove')) as BridgeState
    assert.deepEqual(state.bridges.map((b) => b.id), ['b-keep0001'])
    assert.equal(tg.openPolls['222:DROP'], 0)
    assert.equal(tg.openPolls['111:KEEP'], 1)
    assert.equal(manager.bridge('b-keep0001').view().polling, true)

    const { storage, secrets } = host.data()
    assert.equal(secrets['botToken.b-drop0001'], undefined)
    assert.equal(secrets['botToken.b-keep0001'], '111:KEEP')
    for (const name of ['offset', 'bindings', 'syncCursors', 'lastBlocked', 'knownNames']) {
      assert.equal(storage[`tg.b-drop0001.${name}`], undefined, `tg.b-drop0001.${name} is left behind`)
    }
    assert.deepEqual(storedBridges(host).map((b) => b.id), ['b-keep0001'])
  } finally {
    await worker.deactivate()
  }
})

function lastStatusBar(host: MockHost): { text?: string; tone?: string; tooltip?: string } | undefined {
  return host.callsOf('statusBar.update').at(-1) as { text?: string; tone?: string; tooltip?: string } | undefined
}

test('a bridge whose token Telegram rejects (401) stops alone; the other stays connected', async () => {
  const host = bridgesHost([
    { id: 'b-bad00001', token: '111:REVOKED', config: { enabled: true } },
    { id: 'b-good0001', token: '222:GOOD', config: { enabled: true } }
  ])
  const tg = multiBotTelegram({
    '111:REVOKED': { username: 'old_bot', rejectWith: new TelegramApiError('Unauthorized', 401) },
    '222:GOOD': { username: 'good_bot' }
  })
  const deps = makeMockDeps({ telegram: tg.telegram })
  const { manager, worker } = await mountController(host, {
    telegram: deps.telegram,
    orcaCli: deps.orcaCli,
    retryBackoffMs: 1
  })
  const bad = manager.bridge('b-bad00001')
  const good = manager.bridge('b-good0001')
  try {
    await until(
      () => bad.view().status === 'error' && !bad.view().polling && tg.openPolls['222:GOOD'] === 1,
      'the revoked bridge to stop while the other long-polls'
    )
    assert.equal(good.view().status, 'connected')
    assert.equal(good.view().polling, true)
    assert.equal(good.view().lastError, null)
    await until(() => lastStatusBar(host)?.text === 'TG: 1/2', 'the status bar to count one of two connected')
    assert.equal(lastStatusBar(host)?.tone, 'danger')
  } finally {
    await worker.deactivate()
  }
})

test('the status bar shows Setup without a token, Off with every bridge off, else connected / active', async () => {
  const cases: { seeds: BridgeSeed[]; text: string; tone: string }[] = [
    { seeds: [{ id: 'b-nokey001' }], text: 'TG: Setup', tone: 'warning' },
    { seeds: [{ id: 'b-off00001', token: '111:A' }, { id: 'b-off00002', token: '222:B' }], text: 'TG: Off', tone: 'neutral' },
    {
      seeds: [
        { id: 'b-on000001', token: '111:A', config: { enabled: true } },
        { id: 'b-on000002', token: '222:B', config: { enabled: true } }
      ],
      text: 'TG: 2/2',
      tone: 'success'
    }
  ]
  for (const { seeds, text, tone } of cases) {
    const host = bridgesHost(seeds)
    const tg = multiBotTelegram({ '111:A': { username: 'a_bot' }, '222:B': { username: 'b_bot' } })
    const deps = makeMockDeps({ telegram: tg.telegram })
    const { worker } = await mountController(host, { telegram: deps.telegram, orcaCli: deps.orcaCli })
    try {
      await until(() => lastStatusBar(host)?.text === text, `status bar ${text}`)
      assert.equal(lastStatusBar(host)?.tone, tone, text)
      if (text === 'TG: 2/2') {
        assert.match(lastStatusBar(host)?.tooltip ?? '', /^Bridge 1 \(@a_bot\): connected$/m)
        assert.match(lastStatusBar(host)?.tooltip ?? '', /^Bridge 2 \(@b_bot\): connected$/m)
        assert.match(lastStatusBar(host)?.tooltip ?? '', /\(click to open the panel\)$/)
      }
    } finally {
      await worker.deactivate()
    }
  }
})

test('the palette toggle pauses every running bridge, then starts every bridge that has a token', async () => {
  const host = bridgesHost([
    { id: 'b-run00001', token: '111:A', config: { enabled: true } },
    { id: 'b-idle0001', token: '222:B' },
    { id: 'b-notok001' }
  ])
  const tg = multiBotTelegram({ '111:A': { username: 'a_bot' }, '222:B': { username: 'b_bot' } })
  const deps = makeMockDeps({ telegram: tg.telegram })
  const { manager, worker } = await mountController(host, { telegram: deps.telegram, orcaCli: deps.orcaCli })
  const switches = () => manager.bridges.map((b) => [b.view().config.enabled, b.view().polling])
  try {
    await until(() => manager.bridge('b-run00001').view().polling, 'the running bridge to poll')
    assert.match(String(await worker.command('telegram-bridge.togglePolling')), /paused 1 bridge/)
    assert.deepEqual(switches(), [[false, false], [false, false], [false, false]])

    assert.match(String(await worker.command('telegram-bridge.togglePolling')), /started 2 bridge/)
    assert.deepEqual(switches(), [[true, true], [true, true], [false, false]])
    assert.deepEqual(storedBridges(host).map((b) => b.enabled), [true, true, false])
  } finally {
    await worker.deactivate()
  }
})

test('the open-panel command uses the dev copy key when Orca lists two copies, else the manifest key', async () => {
  let listCalls = 0
  await withPolling(
    false,
    async (_controller, _host, deps, manager) => {
      await manager.openPanel()
      await manager.openPanel()
      assert.deepEqual(
        deps.openedPanels.map((p) => p.pluginKey),
        ['local.telegram-bridge', 'local.telegram-bridge']
      )
      assert.equal(listCalls, 1)
    },
    {
      async listPlugins() {
        listCalls++
        return [
          { pluginKey: 'drecchia.telegram-bridge', isDev: false, status: 'running' },
          { pluginKey: 'local.telegram-bridge', isDev: true, status: 'running' },
          { pluginKey: 'local.other-plugin', isDev: true, status: 'running' }
        ]
      }
    }
  )
  await withPolling(
    false,
    async (_controller, _host, deps, manager) => {
      assert.equal(await manager.openPanel(), 'Telegram panel opened')
      assert.deepEqual(deps.openedPanels, [{ pluginKey: 'drecchia.telegram-bridge', panelId: 'telegram-bridge' }])
    },
    {
      async listPlugins() {
        throw new Error('orca plugin list failed: exit 1')
      }
    }
  )
})

// One bridge with these config fields; testConnection runs getMe, so the bot knows its @username.
async function withGroupBridge(
  config: Record<string, JsonValue>,
  run: (controller: BridgeRuntime, deps: ReturnType<typeof makeMockDeps>, manager: BridgeManager) => Promise<void>
): Promise<void> {
  const host = bridgesHost([{ id: 'b-group001', token: '123456:TEST_TOKEN', config }])
  const deps = makeMockDeps()
  const { manager, controller, worker } = await mountController(host, {
    telegram: deps.telegram,
    orcaCli: deps.orcaCli,
    pollIntervalMs: 1,
    logFlushMs: 0
  })
  try {
    await controller.testConnection()
    await run(controller, deps, manager)
    assert.deepEqual(worker.refusals, [])
  } finally {
    await worker.deactivate()
  }
}

// Telegram's update when someone adds the bot to the group.
function botJoinedGroup(updateId: number): TelegramUpdate {
  return {
    update_id: updateId,
    my_chat_member: {
      chat: { id: GROUP_ID, type: 'supergroup', title: 'Team' },
      from: { id: 555, is_bot: false, first_name: 'Member' },
      date: 1000,
      old_chat_member: { status: 'left', user: BOT_USER },
      new_chat_member: { status: 'member', user: BOT_USER }
    }
  }
}

test('with groups off a group message gets no answer and the bot leaves that group once', async () => {
  await withGroupBridge({ allowGroups: false, allowedUserIds: `777888, ${GROUP_ID}` }, async (controller, deps) => {
    await controller.handleIncomingUpdate(groupUpdate(1, 777888, '@demo_orca_bot status?'))
    await controller.handleIncomingUpdate(groupUpdate(2, 777888, '/help'))
    await controller.handleIncomingUpdate(groupUpdate(3, 555, 'hello'))
    assert.equal(deps.sentToBots.length, 0)
    assert.equal(deps.sentMessages.length, 0)
    assert.deepEqual(deps.leftChats, [GROUP_ID])
    assert.deepEqual(controller.view().bindings, [])
  })
})

test('with groups off the bot leaves a group it is added to, every time; with groups on it stays', async () => {
  await withGroupBridge({ allowGroups: false }, async (controller, deps, manager) => {
    await controller.handleIncomingUpdate(botJoinedGroup(1))
    assert.deepEqual(deps.leftChats, [GROUP_ID])
    const entry = manager.getState().logs.find((e) => e.message.startsWith('Left group'))
    assert.equal(entry?.message, `Left group ${GROUP_ID} (Team): groups are off for this bridge`)
    assert.equal(entry?.level, 'info')
    assert.equal(entry?.bridgeId, 'b-group001')
    // Added again later: the bot leaves again.
    await controller.handleIncomingUpdate(botJoinedGroup(2))
    assert.deepEqual(deps.leftChats, [GROUP_ID, GROUP_ID])
  })
  await withGroupBridge({ allowGroups: true }, async (controller, deps) => {
    await controller.handleIncomingUpdate(botJoinedGroup(1))
    assert.deepEqual(deps.leftChats, [])
  })
})

test('joining a group in learning mode logs its ID and warns while privacy mode keeps messages away', async () => {
  const config = { allowGroups: true, groupMode: 'all', groupReply: 'learn', allowedUserIds: '777888' }
  await withGroupBridge(config, async (controller, deps, manager) => {
    // Logs are newest first.
    const joinLog = () => manager.getState().logs.find((e) => e.message.startsWith('Added to group'))
    await controller.handleIncomingUpdate(botJoinedGroup(1))
    assert.equal(
      joinLog()?.message,
      `Added to group ${GROUP_ID} (Team): the bot is a member. Privacy mode is on, so ordinary group messages never reach learning mode here: disable it in @BotFather (/setprivacy) and add the bot again, or make the bot an admin. To allow everyone in it, add ${GROUP_ID} under "Only these people and groups".`
    )
    assert.equal(joinLog()?.level, 'info')

    // The owner disables privacy in @BotFather and adds the bot again: getMe is read anew.
    deps.telegram.getMe = async () => ({ ...BOT_USER, can_join_groups: true, can_read_all_group_messages: true })
    await controller.handleIncomingUpdate(botJoinedGroup(2))
    assert.deepEqual(controller.view().telegramCaps, { canJoinGroups: true, canReadAllGroupMessages: true })
    assert.equal(
      joinLog()?.message,
      `Added to group ${GROUP_ID} (Team): the bot is a member. To allow everyone in it, add ${GROUP_ID} under "Only these people and groups".`
    )
  })
})

test("'addressed' answers mentions in an allowed group and ignores the rest of the talk", async () => {
  await withGroupBridge(
    { allowGroups: true, groupMode: 'addressed', allowedUserIds: `777888, ${GROUP_ID}` },
    async (controller, deps) => {
      await controller.handleIncomingUpdate(groupUpdate(1, 777888, 'lunch at noon?'))
      assert.equal(deps.sentToBots.length, 0)
      await controller.handleIncomingUpdate(groupUpdate(2, 777888, '@demo_orca_bot what is due today?'))
      assert.equal(deps.sentToBots.length, 1)
      assert.equal(lastBodyLine(deps), 'what is due today?')
      assert.deepEqual(deps.leftChats, [])
    }
  )
})

test("'all' with a restricted allowlist sends every line of an allowed member, and only theirs", async () => {
  await withGroupBridge({ allowGroups: true, groupMode: 'all', allowedUserIds: '777888' }, async (controller, deps) => {
    await controller.handleIncomingUpdate(groupUpdate(1, 777888, 'the deploy failed again'))
    assert.equal(deps.sentToBots.length, 1)
    assert.equal(lastBodyLine(deps), 'the deploy failed again')

    // Another member chatting in the group is neither sent on nor told off.
    await controller.handleIncomingUpdate(groupUpdate(2, 555, 'I will look at it'))
    assert.equal(deps.sentToBots.length, 1)
    assert.ok(!deps.sentMessages.some((m) => m.text === t('en').unauthorized('555')))
    assert.equal(controller.view().lastBlockedUserId, null)

    // Commands still work.
    const before = deps.sentMessages.length
    await controller.handleIncomingUpdate(groupUpdate(3, 777888, '/status'))
    assert.equal(deps.sentToBots.length, 1)
    assert.equal(deps.sentMessages.length, before + 1)
  })
})

test("'all' with an open allowlist acts as 'addressed': a plain group line starts no Orca run", async () => {
  await withGroupBridge({ allowGroups: true, groupMode: 'all', allowedUserIds: '' }, async (controller, deps) => {
    await controller.handleIncomingUpdate(groupUpdate(1, 555, 'anyone up for lunch?'))
    assert.equal(deps.sentToBots.length, 0)
    assert.equal(deps.sentMessages.length, 0)
    await controller.handleIncomingUpdate(groupUpdate(2, 555, '@demo_orca_bot hello'))
    assert.equal(deps.sentToBots.length, 1)
  })
})

function documentUpdate(updateId: number, document: TelegramDocument, caption?: string): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: 50 + updateId,
      from: { id: 777888, is_bot: false, first_name: 'Demo' },
      chat: { id: 777888, type: 'private' },
      date: 1000,
      ...(caption ? { caption } : {}),
      document
    }
  }
}

const FILES_HEADER =
  'Attached Telegram file(s) saved locally (open them with your tools; the original name is in parentheses):'

// The first "- <path> (<name>)" line of the last body the Orca bot received.
function lastFileLine(deps: ReturnType<typeof makeMockDeps>): { savedPath: string; name: string } {
  const lines = deps.sentToBots.at(-1)?.body.split('\n') ?? []
  const header = lines.indexOf(FILES_HEADER)
  assert.ok(header >= 0, 'the body lists the file')
  const match = /^- (.+) \((.+)\)$/.exec(lines[header + 1] ?? '')
  assert.ok(match, 'the file line has a path and a name')
  return { savedPath: match[1], name: match[2] }
}

// A spreadsheet without a caption used to be dropped, and with one only the caption arrived.
test('a non-image document reaches the Orca bot as a file saved under a safe name, with its original name', async () => {
  const downloadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-tg-bridge-test-'))
  const filesDir = path.join(downloadDir, 'orca-telegram-bridge', 'files')
  const telegramPaths: Record<string, string> = {
    'doc-xlsx': 'documents/file_5.xlsx',
    'doc-evil': 'documents/file_6.xlsx',
    'doc-noname': 'documents/file_7.pdf',
    'doc-long': 'documents/file_8.csv',
    'doc-pdf': 'documents/file_9.pdf',
    'doc-docx': 'documents/file_10.docx'
  }
  const deps = makeMockDeps({
    telegram: {
      async getFile(_token, fileId) {
        return { file_id: fileId, file_unique_id: `u_${fileId}`, file_path: telegramPaths[fileId] }
      },
      async downloadFile(_token, filePath) {
        return Buffer.from(`bytes-for-${filePath}`)
      }
    }
  })
  const { manager, controller, worker } = await mountBridge(loggingHost(), deps, { downloadDir })
  try {
    // A download from two days ago is cleaned up by the next one.
    await fs.mkdir(filesDir, { recursive: true })
    const oldFile = path.join(filesDir, 'tg-1-1-old-old.xlsx')
    await fs.writeFile(oldFile, 'old')
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000)
    await fs.utimes(oldFile, twoDaysAgo, twoDaysAgo)

    // 1. No caption: the saved path, the original name and the default request.
    await within(
      controller.handleIncomingUpdate(
        documentUpdate(1, {
          file_id: 'doc-xlsx',
          file_unique_id: 'x1',
          file_name: 'Q3 report.xlsx',
          mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          file_size: 2048
        })
      ),
      'xlsx without caption'
    )
    assert.equal(deps.sentToBots.length, 1)
    assert.match(deps.sentToBots[0].subject, /\[File\]/)
    const first = lastFileLine(deps)
    assert.equal(first.name, 'Q3 report.xlsx')
    assert.equal(path.dirname(first.savedPath), filesDir)
    assert.match(path.basename(first.savedPath), /^tg-\d+-51-[a-z0-9]*-Q3_report\.xlsx$/)
    assert.equal(await fs.readFile(first.savedPath, 'utf8'), 'bytes-for-documents/file_5.xlsx')
    assert.equal(lastBodyLine(deps), 'Please open the attached file(s) above and respond.')
    assert.equal((await fs.readdir(filesDir)).includes('tg-1-1-old-old.xlsx'), false)
    // The log has the extension and the size, never the name.
    assert.ok(manager.getState().logs.some((e) => e.message.endsWith('] document .xlsx 2048 bytes')))

    // 2. With a caption the caption is the text; a "../" name cannot leave the files folder.
    await within(
      controller.handleIncomingUpdate(
        documentUpdate(
          2,
          { file_id: 'doc-evil', file_unique_id: 'x2', file_name: '../evil.xlsx', mime_type: 'application/vnd.ms-excel' },
          'Sum column B'
        )
      ),
      'xlsx with caption'
    )
    assert.equal(deps.sentToBots.length, 2)
    assert.equal(lastBodyLine(deps), 'Sum column B')
    const second = lastFileLine(deps)
    assert.equal(second.name, '../evil.xlsx')
    assert.equal(path.dirname(second.savedPath), filesDir)
    assert.match(path.basename(second.savedPath), /^tg-\d+-52-[a-z0-9]*-\.\._evil\.xlsx$/)
    // An unknown size is tried.
    assert.ok(manager.getState().logs.some((e) => e.message.endsWith('] text 12 chars + document .xlsx unknown bytes')))

    // 3. No name: "file" and the extension of Telegram's path.
    await within(
      controller.handleIncomingUpdate(
        documentUpdate(3, { file_id: 'doc-noname', file_unique_id: 'x3', mime_type: 'application/pdf', file_size: 100 })
      ),
      'no file name'
    )
    const third = lastFileLine(deps)
    assert.equal(third.name, 'file.pdf')
    assert.match(path.basename(third.savedPath), /^tg-\d+-53-[a-z0-9]*-file\.pdf$/)

    // 4. A long name is cut to 80 chars, keeping the extension.
    await within(
      controller.handleIncomingUpdate(
        documentUpdate(4, { file_id: 'doc-long', file_unique_id: 'x4', file_name: `${'ç'.repeat(100)}.csv`, mime_type: 'text/csv' })
      ),
      'long name'
    )
    const savedName = path.basename(lastFileLine(deps).savedPath).replace(/^tg-\d+-54-[a-z0-9]*-/, '')
    assert.equal(savedName, `${'_'.repeat(76)}.csv`)

    // 5. A PDF and a Word document reach the bot the same way.
    await within(
      controller.handleIncomingUpdate(
        documentUpdate(5, {
          file_id: 'doc-pdf',
          file_unique_id: 'x5',
          file_name: 'Invoice 2026.pdf',
          mime_type: 'application/pdf',
          file_size: 4096
        })
      ),
      'pdf'
    )
    const pdf = lastFileLine(deps)
    assert.equal(pdf.name, 'Invoice 2026.pdf')
    assert.equal(path.dirname(pdf.savedPath), filesDir)
    assert.match(path.basename(pdf.savedPath), /^tg-\d+-55-[a-z0-9]*-Invoice_2026\.pdf$/)
    assert.equal(await fs.readFile(pdf.savedPath, 'utf8'), 'bytes-for-documents/file_9.pdf')
    assert.equal(lastBodyLine(deps), 'Please open the attached file(s) above and respond.')
    assert.ok(manager.getState().logs.some((e) => e.message.endsWith('] document .pdf 4096 bytes')))

    await within(
      controller.handleIncomingUpdate(
        documentUpdate(
          6,
          {
            file_id: 'doc-docx',
            file_unique_id: 'x6',
            file_name: 'Contract draft.docx',
            mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            file_size: 8192
          },
          'Review clause 4'
        )
      ),
      'docx'
    )
    const docx = lastFileLine(deps)
    assert.equal(docx.name, 'Contract draft.docx')
    assert.equal(path.dirname(docx.savedPath), filesDir)
    assert.match(path.basename(docx.savedPath), /^tg-\d+-56-[a-z0-9]*-Contract_draft\.docx$/)
    assert.equal(await fs.readFile(docx.savedPath, 'utf8'), 'bytes-for-documents/file_10.docx')
    assert.equal(lastBodyLine(deps), 'Review clause 4')
    assert.ok(manager.getState().logs.some((e) => e.message.endsWith('] text 15 chars + document .docx 8192 bytes')))

    assert.equal(deps.sentToBots.length, 6)
    assert.equal((await fs.readdir(filesDir)).length, 6)
    assert.equal((await fs.readdir(downloadDir)).join(','), 'orca-telegram-bridge')
    assert.equal((await fs.readdir(path.join(downloadDir, 'orca-telegram-bridge'))).join(','), 'files')
    const logs = JSON.stringify(manager.getState().logs)
    assert.equal(/Q3|evil|ç|Invoice|Contract/.test(logs), false)
    assert.equal(worker.refusals.length, 0)
  } finally {
    await worker.deactivate()
    await fs.rm(downloadDir, { recursive: true, force: true })
  }
})

test('a document over 20 MB gets one plain line and is neither downloaded nor sent to the Orca bot', async () => {
  const deps = makeMockDeps({
    telegram: {
      async getFile() {
        throw new Error('getFile must not be called for a file over 20 MB')
      }
    }
  })
  const { manager, controller, worker } = await mountBridge(loggingHost(), deps)
  const bytes = 25 * 1024 * 1024
  try {
    await within(
      controller.handleIncomingUpdate(
        documentUpdate(1, {
          file_id: 'doc-big',
          file_unique_id: 'b1',
          file_name: 'backup.zip',
          mime_type: 'application/zip',
          file_size: bytes
        })
      ),
      'large file'
    )
    assert.equal(deps.sentToBots.length, 0)
    assert.equal(deps.sentMessages.length, 1)
    assert.equal(deps.sentMessages[0].text, t('en').fileTooLarge)
    const log = manager.getState().logs.find((e) => e.message.startsWith('Refused document'))
    assert.equal(
      log?.message,
      `Refused document .zip ${bytes} bytes in message 51, chat 777888: over the 20 MB a Telegram bot can download.`
    )
    assert.equal(JSON.stringify(manager.getState().logs).includes('backup'), false)
    assert.equal(worker.refusals.length, 0)
  } finally {
    await worker.deactivate()
  }
})

test('in a group a file follows the same addressing rules as an image', async () => {
  const downloadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-tg-bridge-test-'))
  const host = bridgesHost([
    {
      id: 'b-group001',
      token: '123456:TEST_TOKEN',
      config: { allowGroups: true, groupMode: 'addressed', allowedUserIds: `777888, ${GROUP_ID}` }
    }
  ])
  const deps = makeMockDeps()
  const { controller, worker } = await mountBridge(host, deps, { downloadDir })
  const sheet: TelegramDocument = {
    file_id: 'doc-sheet',
    file_unique_id: 's1',
    file_name: 'plan.xlsx',
    mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    file_size: 300
  }
  try {
    await controller.testConnection()
    // Not addressed to the bot: ignored, not even downloaded.
    await within(
      controller.handleIncomingUpdate(groupUpdate(1, 777888, '', { text: undefined, document: sheet })),
      'unaddressed file'
    )
    assert.equal(deps.sentToBots.length, 0)
    assert.equal(deps.sentMessages.length, 0)

    // A mention in the caption: the caption without the mention is the text.
    await within(
      controller.handleIncomingUpdate(
        groupUpdate(2, 777888, '', { text: undefined, caption: '@demo_orca_bot check the totals', document: sheet })
      ),
      'mentioned file'
    )
    assert.equal(deps.sentToBots.length, 1)
    assert.equal(lastBodyLine(deps), 'check the totals')
    assert.equal(lastFileLine(deps).name, 'plan.xlsx')

    // A reply to the bot without a caption: the default request.
    await within(
      controller.handleIncomingUpdate(
        groupUpdate(3, 777888, '', {
          text: undefined,
          document: sheet,
          reply_to_message: { message_id: 90, from: BOT_USER, chat: { id: GROUP_ID, type: 'supergroup', title: 'Team' }, date: 999 }
        })
      ),
      'file replying to the bot'
    )
    assert.equal(deps.sentToBots.length, 2)
    assert.equal(lastBodyLine(deps), 'Please open the attached file(s) above and respond.')
    assert.equal(worker.refusals.length, 0)
  } finally {
    await worker.deactivate()
    await fs.rm(downloadDir, { recursive: true, force: true })
  }
})

const SILENT_LINE =
  'This group message was not addressed to you. Read it for context only and do not reply: answer exactly NO_REPLY. Nothing you write is sent to Telegram.'
const HELPFUL_LINE =
  'This group message was not addressed to you. Reply only if you can clearly help with it; otherwise answer exactly NO_REPLY. A reply is sent back to the group (use standard Markdown tables; avoid wide ASCII box tables).'

function groupMessages(deps: ReturnType<typeof makeMockDeps>) {
  return deps.sentMessages.filter((m) => m.chatId === GROUP_ID)
}

function typed(deps: ReturnType<typeof makeMockDeps>): boolean {
  return deps.sentActions.some((a) => a.action === 'typing')
}

test("'all' + reply only when addressed: an unaddressed line reaches the bot as context, and its answer stays out of the group", async () => {
  await withGroupBridge({ allowGroups: true, groupMode: 'all', groupReply: 'mentioned', allowedUserIds: '777888' }, async (controller, deps, manager) => {
    await within(controller.handleIncomingUpdate(groupUpdate(1, 777888, 'the deploy failed again')), 'unaddressed line')
    assert.equal(deps.sentToBots.length, 1)
    assert.ok(deps.sentToBots[0].body.includes(SILENT_LINE))
    assert.equal(deps.sentToBots[0].body.includes(HELPFUL_LINE), false)
    assert.equal(lastBodyLine(deps), 'the deploy failed again')
    // The mock bot answered "Reply #1 from Assistant" (23 chars); the bridge keeps it out of the group.
    assert.deepEqual(groupMessages(deps), [])
    assert.equal(typed(deps), false)
    const entry = manager.getState().logs.find((e) => e.message.includes("in 'mentioned' mode"))
    assert.match(entry?.message ?? '', /Unaddressed group message in 'mentioned' mode: reply of 23 chars not sent\.$/)
    assert.equal(entry?.level, 'info')
    assert.equal(manager.getState().logs.some((e) => e.message.includes('Reply #1')), false)
  })
})

test("'all' + reply when it can help: an unaddressed answer goes to the group, NO_REPLY sends nothing", async () => {
  await withGroupBridge(
    { allowGroups: true, groupMode: 'all', groupReply: 'helpful', allowedUserIds: '777888' },
    async (controller, deps) => {
      await within(controller.handleIncomingUpdate(groupUpdate(1, 777888, 'how do I restart the worker?')), 'helpful answer')
      assert.equal(deps.sentToBots.length, 1)
      assert.ok(deps.sentToBots[0].body.includes(HELPFUL_LINE))
      assert.equal(deps.sentToBots[0].body.includes(SILENT_LINE), false)
      assert.equal(groupMessages(deps).at(-1)?.text, 'Reply #1 from Assistant')
      assert.equal(groupMessages(deps).at(-1)?.replyToMessageId, 101)
      assert.equal(typed(deps), false)

      const readSession = deps.orcaCli.readSession
      deps.orcaCli.readSession = async (sessionId, limit) => {
        const session = await readSession(sessionId, limit)
        return {
          ...session,
          entries: session.entries.map((e) =>
            e.kind === 'message' && e.role === 'assistant' ? { ...e, text: 'NO_REPLY' } : e
          )
        }
      }
      const before = groupMessages(deps).length
      await within(controller.handleIncomingUpdate(groupUpdate(2, 777888, 'lunch at noon?')), 'quiet answer')
      assert.equal(deps.sentToBots.length, 2)
      assert.equal(groupMessages(deps).length, before)
    }
  )
})

test("'all': a message addressed to the bot is answered as before, in both reply modes", async () => {
  for (const groupReply of ['mentioned', 'helpful']) {
    await withGroupBridge(
      { allowGroups: true, groupMode: 'all', groupReply, allowedUserIds: '777888' },
      async (controller, deps) => {
        await within(
          controller.handleIncomingUpdate(groupUpdate(1, 777888, '@demo_orca_bot what is due today?')),
          `addressed in ${groupReply}`
        )
        assert.equal(deps.sentToBots.length, 1)
        assert.equal(deps.sentToBots[0].body.includes('was not addressed to you'), false)
        assert.equal(lastBodyLine(deps), 'what is due today?')
        assert.equal(groupMessages(deps).at(-1)?.text, 'Reply #1 from Assistant')
        assert.ok(typed(deps), `no typing action in ${groupReply}`)
      }
    )
  }
})

const LEARN_LINE =
  'You are in learning mode in this Telegram group: read this message and learn from it as your instructions (SOUL.md) say. Never reply, even when the message mentions or asks you: answer exactly NO_REPLY. Nothing you write is sent to Telegram.'
const LEARNING = { allowGroups: true, groupMode: 'all', groupReply: 'learn', allowedUserIds: '777888' }

test("'all' + learn: every line reaches the bot to learn from, even when called, and nothing is posted in the group", async () => {
  await withGroupBridge(LEARNING, async (controller, deps, manager) => {
    const reply = { message_id: 90, from: BOT_USER, chat: { id: GROUP_ID, type: 'supergroup' as const, title: 'Team' }, date: 999 }
    await within(controller.handleIncomingUpdate(groupUpdate(1, 777888, 'the deploy failed again')), 'plain line')
    await within(controller.handleIncomingUpdate(groupUpdate(2, 777888, '@demo_orca_bot what is due today?')), 'mention')
    await within(controller.handleIncomingUpdate(groupUpdate(3, 777888, 'and this?', { reply_to_message: reply })), 'reply')
    assert.equal(deps.sentToBots.length, 3)
    for (const sent of deps.sentToBots) {
      assert.ok(sent.body.includes(LEARN_LINE))
      assert.equal(sent.body.includes('To send an image or file'), false)
    }
    assert.equal(lastBodyLine(deps), 'and this?')
    assert.ok(deps.sentToBots[1].body.includes('what is due today?'))
    // The mock bot answers every line; the bridge keeps all of it out of the group.
    assert.deepEqual(groupMessages(deps), [])
    assert.equal(typed(deps), false)
    assert.ok(manager.getState().logs.some((e) => /in 'learn' mode: reply of \d+ chars not sent\.$/.test(e.message)))

    // A command is neither run nor sent on; a stranger calling the bot is not told off.
    await controller.handleIncomingUpdate(groupUpdate(4, 777888, '/status'))
    await controller.handleIncomingUpdate(groupUpdate(5, 777888, '/new@demo_orca_bot'))
    await controller.handleIncomingUpdate(groupUpdate(6, 555, '@demo_orca_bot hello'))
    assert.equal(deps.sentToBots.length, 3)
    assert.deepEqual(deps.sentMessages, [])
    assert.equal(controller.view().lastBlockedUserId, null)
  })
})

test("'all' + learn: a button on an older group message does nothing", async () => {
  await withGroupBridge(LEARNING, async (controller, deps) => {
    await controller.handleIncomingUpdate(buttonUpdate(1, 777888, GROUP_ID, 'n:new'))
    assert.deepEqual(deps.sentMessages, [])
    assert.deepEqual(deps.answeredCallbacks, [])
    assert.equal(deps.sentToBots.length, 0)
  })
})

test("'all' + learn: Orca-side sync skips the group's chat and still serves private chats", async () => {
  let activity = 1000
  const sessions: Record<string, OrcaSessionRead> = {
    'orca-group': { orcaSessionId: 'orca-group', state: 'done', entries: [{ kind: 'message', role: 'assistant', text: 'Old reply' }] },
    'orca-private': { orcaSessionId: 'orca-private', state: 'done', entries: [{ kind: 'message', role: 'assistant', text: 'Old reply' }] }
  }
  const chat = (id: string) => ({
    id,
    title: id,
    lastActivityAt: activity,
    lastAsked: null,
    lastSaid: null,
    home: false,
    self: false,
    closed: false
  })
  const host = bridgesHost([
    {
      id: 'b-learn001',
      token: '123456:TEST_TOKEN',
      config: { ...LEARNING, allowedUserIds: `777888, ${GROUP_ID}`, syncOrcaOutbound: true },
      state: {
        bindings: [
          { tgChatId: String(GROUP_ID), botId: 'bot-1', botName: 'Assistant', orcaChatId: 'orca-group', updatedAt: 1000 },
          { tgChatId: '777888', botId: 'bot-1', botName: 'Assistant', orcaChatId: 'orca-private', updatedAt: 1000 }
        ]
      }
    }
  ])
  const deps = makeMockDeps({
    orcaCli: {
      async listBotChats() {
        return [chat('orca-group'), chat('orca-private')]
      },
      async readSession(sessionId) {
        const session = sessions[sessionId]
        return { ...session, entries: [...session.entries] }
      }
    }
  })
  const { controller, worker } = await mountController(host, { telegram: deps.telegram, orcaCli: deps.orcaCli })
  try {
    await controller.syncOrcaBoundChatsOnce()
    activity = 2000
    for (const session of Object.values(sessions)) {
      session.entries.push({ kind: 'message', role: 'user', text: 'Typed in Orca' })
    }
    await controller.syncOrcaBoundChatsOnce()
    assert.deepEqual(deps.sentMessages.map((m) => String(m.chatId)), ['777888'])
  } finally {
    await controller.dispose()
    await worker.deactivate()
  }
})

test('Telegram caps come from getMe, are null before it, and reset with a new token', async () => {
  const host = bridgesHost([{ id: 'b-caps0001', token: '123456:TEST_TOKEN' }])
  const deps = makeMockDeps({
    telegram: {
      async getMe() {
        return { ...BOT_USER, can_join_groups: true, can_read_all_group_messages: false }
      }
    }
  })
  const { manager, controller, worker } = await mountController(host, { telegram: deps.telegram, orcaCli: deps.orcaCli })
  try {
    assert.equal(controller.view().telegramCaps, null)
    await controller.testConnection()
    assert.deepEqual(controller.view().telegramCaps, { canJoinGroups: true, canReadAllGroupMessages: false })
    const state = (await worker.request('bridge.getState')) as BridgeState
    assert.deepEqual(state.bridges[0].telegramCaps, { canJoinGroups: true, canReadAllGroupMessages: false })

    await manager.saveConfig(saveInput(controller, { botToken: '654321:OTHER_TOKEN' }))
    assert.equal(controller.view().telegramCaps, null)
  } finally {
    await worker.deactivate()
  }
})

test('each poll run reads getMe again, so a privacy change in @BotFather shows after a restart', async () => {
  const host = bridgesHost([{ id: 'b-caps0002', token: '123456:TEST_TOKEN', config: { enabled: true } }])
  let privacyOn = true
  const deps = makeMockDeps({
    telegram: {
      async getMe() {
        return { ...BOT_USER, can_join_groups: true, can_read_all_group_messages: !privacyOn }
      },
      // Like Telegram with no new updates: a long poll holds until the loop aborts, a short poll answers.
      async getUpdates(_token, params, options) {
        if ((params.timeoutSec ?? 0) > 0) {
          const aborted = Promise.withResolvers<void>()
          options?.signal?.addEventListener('abort', () => aborted.resolve(), { once: true })
          if (!options?.signal?.aborted) await aborted.promise
        }
        return []
      }
    }
  })
  const { manager, controller, worker } = await mountController(host, { telegram: deps.telegram, orcaCli: deps.orcaCli })
  try {
    await until(() => controller.view().status === 'connected', 'first connect')
    assert.deepEqual(controller.view().telegramCaps, { canJoinGroups: true, canReadAllGroupMessages: false })

    privacyOn = false
    await within(manager.togglePolling(), 'pause')
    await within(manager.togglePolling(), 'start again')
    await until(() => controller.view().telegramCaps?.canReadAllGroupMessages === true, 'caps read again')
  } finally {
    await within(controller.dispose(), 'dispose')
    await worker.deactivate()
  }
})

test('a bridge stored without group options keeps groups on, and a save without them keeps them', async () => {
  // Stored by a 0.5.0 build from before group options: no allowGroups or groupMode.
  const host = bridgesHost([{ id: 'b-older001', token: '123456:TEST_TOKEN' }])
  const deps = makeMockDeps()
  const { manager, controller, worker } = await mountController(host, { telegram: deps.telegram, orcaCli: deps.orcaCli })
  try {
    assert.equal(controller.view().config.allowGroups, true)
    assert.equal(controller.view().config.groupMode, 'addressed')

    await manager.saveConfig(saveInput(controller, { groupMode: 'all' }))
    await manager.saveConfig(saveInput(controller, { allowedUserIds: '777888, 42' }))
    assert.equal(controller.view().config.allowGroups, true)
    assert.equal(controller.view().config.groupMode, 'all')
    const stored = (host.data().storage.bridges as { allowGroups: boolean; groupMode: string }[])[0]
    assert.deepEqual([stored.allowGroups, stored.groupMode], [true, 'all'])
  } finally {
    await worker.deactivate()
  }
})

// The panel no longer sends a name: the bridge keeps the one it has.
test('a save without a name keeps it; groupReply defaults to mentioned, round-trips, and a save without it keeps it', async () => {
  const host = bridgesHost([{ id: 'b-reply001', token: '123456:TEST_TOKEN', config: { name: 'Team bot' } }])
  const deps = makeMockDeps()
  const { controller, worker } = await mountController(host, { telegram: deps.telegram, orcaCli: deps.orcaCli })
  try {
    assert.equal(controller.view().config.groupReply, 'mentioned')

    const { name: _name, ...withoutName } = saveInput(controller, { groupMode: 'all', groupReply: 'helpful' })
    const saved = (await worker.request('bridge.saveConfig', withoutName)) as BridgeState
    assert.equal(saved.bridges[0].name, 'Team bot')
    assert.equal(saved.bridges[0].config.groupReply, 'helpful')

    // A blank name and no groupReply keep both.
    await worker.request('bridge.saveConfig', saveInput(controller, { name: '  ' }))
    assert.equal(controller.view().config.name, 'Team bot')
    assert.equal(controller.view().config.groupReply, 'helpful')
    const stored = (host.data().storage.bridges as { name: string; groupReply: string }[])[0]
    assert.deepEqual([stored.name, stored.groupReply], ['Team bot', 'helpful'])

    await worker.request('bridge.saveConfig', saveInput(controller, { groupReply: 'mentioned' }))
    assert.equal(controller.view().config.groupReply, 'mentioned')
    await worker.request('bridge.saveConfig', saveInput(controller, { groupReply: 'learn' }))
    assert.equal(controller.view().config.groupReply, 'learn')
    assert.equal((host.data().storage.bridges as { groupReply: string }[])[0].groupReply, 'learn')
    assert.deepEqual(worker.refusals, [])
  } finally {
    await worker.deactivate()
  }
})

// Before 0.8.0, All messages answered every group message: an upgraded bridge keeps answering.
test("a bridge stored before groupReply keeps answering with All messages ('helpful'); others start at 'mentioned'", async () => {
  const host = bridgesHost([
    { id: 'b-legacyall', token: '123456:TEST_TOKEN', config: { name: 'Old all', groupMode: 'all' } },
    { id: 'b-legacyadr', token: '654321:TEST_TOKEN', config: { name: 'Old addressed', groupMode: 'addressed' } }
  ])
  const deps = makeMockDeps()
  const { worker } = await mountController(host, { telegram: deps.telegram, orcaCli: deps.orcaCli })
  try {
    const state = (await worker.request('bridge.getState')) as BridgeState
    const replyOf = (name: string) => state.bridges.find((b) => b.name === name)?.config.groupReply
    assert.equal(replyOf('Old all'), 'helpful')
    assert.equal(replyOf('Old addressed'), 'mentioned')
  } finally {
    await worker.deactivate()
  }
})

const VOICE_KEY = 'sk-or-v1-VOICEKEY0123456789abcdef'

function voiceUpdate(
  updateId: number,
  kind: 'voice' | 'audio',
  extra: Partial<TelegramMessage> = {},
  fileSize = 4000
): TelegramUpdate {
  const media = { file_id: `${kind}-file-${updateId}`, file_unique_id: `u-${updateId}`, duration: 3, file_size: fileSize }
  return {
    update_id: updateId,
    message: {
      message_id: 100 + updateId,
      from: { id: 777888, is_bot: false, first_name: 'User' },
      chat: { id: 777888, type: 'private' },
      date: 1000,
      ...(kind === 'voice'
        ? { voice: { ...media, mime_type: 'audio/ogg' } }
        : { audio: { ...media, mime_type: 'audio/mpeg', file_name: 'memo.mp3' } }),
      ...extra
    }
  }
}

// A bridge in the 0.5.0 layout with voice options and key as given; `transcribe` records each call.
async function withVoiceBridge(
  options: { config?: Record<string, JsonValue>; voiceKey?: string; transcribe?: (p: TranscribeParams) => Promise<string> },
  run: (ctx: {
    controller: BridgeRuntime
    manager: BridgeManager
    deps: ReturnType<typeof makeMockDeps>
    host: MockHost
    calls: TranscribeParams[]
    worker: Awaited<ReturnType<typeof mountBridge>>['worker']
  }) => Promise<void>
): Promise<void> {
  const host = bridgesHost(
    [{ id: 'b-voice001', token: REAL_TOKEN, voiceKey: options.voiceKey, config: options.config ?? {} }],
    { debugLogging: true }
  )
  const deps = makeMockDeps()
  const calls: TranscribeParams[] = []
  const { manager, controller, worker } = await mountBridge(host, deps, {
    transcribe: async (params) => {
      calls.push(params)
      return options.transcribe ? options.transcribe(params) : 'turn on the lights'
    }
  })
  try {
    await run({ controller, manager, deps, host, calls, worker })
  } finally {
    await worker.deactivate()
  }
}

const VOICE_ON = { voiceEnabled: true, voiceProvider: 'openai', voiceModel: 'gpt-transcribe' }

test('a voice message on a bridge with voice on reaches the Orca bot as the prefixed transcript', async () => {
  await withVoiceBridge({ config: VOICE_ON, voiceKey: VOICE_KEY }, async ({ controller, deps, calls }) => {
    await controller.handleIncomingUpdate(voiceUpdate(1, 'voice'))
    assert.equal(calls.length, 1)
    assert.equal(calls[0].provider, 'openai')
    assert.equal(calls[0].apiKey, VOICE_KEY)
    assert.equal(calls[0].fileName, 'voice.ogg')
    assert.equal(calls[0].audio.toString(), 'fake-image-bytes')
    assert.equal(lastBodyLine(deps), '[Voice message, transcribed] turn on the lights')
    assert.ok(deps.sentActions.some((a) => a.action === 'typing'), 'no typing action while transcribing')
  })
})

test('an audio file is transcribed under its own file name and dispatched like a voice message', async () => {
  await withVoiceBridge({ config: VOICE_ON, voiceKey: VOICE_KEY }, async ({ controller, deps, calls }) => {
    await controller.handleIncomingUpdate(voiceUpdate(1, 'audio'))
    assert.equal(calls[0].fileName, 'memo.mp3')
    assert.equal(calls[0].mimeType, 'audio/mpeg')
    assert.equal(lastBodyLine(deps), '[Voice message, transcribed] turn on the lights')
  })
})

test('a voice caption comes first on its own line, then the transcript', async () => {
  await withVoiceBridge({ config: VOICE_ON, voiceKey: VOICE_KEY }, async ({ controller, deps }) => {
    await controller.handleIncomingUpdate(voiceUpdate(1, 'voice', { caption: '/new please' }))
    const body = deps.sentToBots.at(-1)?.body ?? ''
    assert.ok(body.endsWith('/new please\n[Voice message, transcribed] turn on the lights'), body)
  })
})

test('with voice off, or on without a key, the sender is told and nothing reaches the Orca bot', async () => {
  for (const options of [{ voiceKey: VOICE_KEY }, { config: VOICE_ON }]) {
    await withVoiceBridge(options, async ({ controller, deps, calls }) => {
      await controller.handleIncomingUpdate(voiceUpdate(1, 'voice'))
      assert.equal(calls.length, 0)
      assert.equal(deps.sentToBots.length, 0)
      assert.equal(deps.sentMessages.at(-1)?.text, t('en').voiceDisabled)
    })
  }
})

test('a failing transcription answers with the reason, dispatches nothing and never logs the key', async () => {
  await withVoiceBridge(
    {
      config: VOICE_ON,
      voiceKey: VOICE_KEY,
      transcribe: async () => {
        throw new Error(`OpenAI error 401: Incorrect API key provided: ${VOICE_KEY}`)
      }
    },
    async ({ controller, manager, deps, host, worker }) => {
      await controller.handleIncomingUpdate(voiceUpdate(1, 'voice'))
      assert.equal(deps.sentToBots.length, 0)
      const reply = deps.sentMessages.at(-1)?.text ?? ''
      assert.match(reply, /^Could not transcribe the voice message: OpenAI error 401/)
      assert.ok(!reply.includes(VOICE_KEY), 'the Telegram reply holds the voice key')
      const warn = storedLogs(host).find((e) => e.level === 'warn' && /not transcribed/.test(e.message))
      assert.ok(warn, 'no warn entry for the failed transcription')
      assert.match(warn?.details ?? '', /provider=openai/)
      assert.match(warn?.details ?? '', /bytes=16/)
      const surfaces = [
        JSON.stringify(manager.getState()),
        JSON.stringify(host.data().storage),
        worker.logs.join('\n'),
        (await manager.exportLogs()).text
      ]
      for (const text of surfaces) assert.ok(!text.includes(VOICE_KEY), 'a surface holds the voice key')
    }
  )
})

test('a voice file over 20 MB is refused before downloading', async () => {
  await withVoiceBridge({ config: VOICE_ON, voiceKey: VOICE_KEY }, async ({ controller, deps, calls }) => {
    // 21 MB: under the providers' 25 MB but over what Telegram lets a bot download.
    await controller.handleIncomingUpdate(voiceUpdate(1, 'voice', {}, 21 * 1024 * 1024))
    assert.equal(calls.length, 0)
    assert.equal(deps.sentToBots.length, 0)
    assert.equal(deps.sentMessages.at(-1)?.text, t('en').voiceFailed(t('en').voiceTooLarge))
  })
})

test('an empty transcript is answered as such and dispatches nothing', async () => {
  await withVoiceBridge({ config: VOICE_ON, voiceKey: VOICE_KEY, transcribe: async () => '  ' }, async ({ controller, deps }) => {
    await controller.handleIncomingUpdate(voiceUpdate(1, 'voice'))
    assert.equal(deps.sentToBots.length, 0)
    assert.equal(deps.sentMessages.at(-1)?.text, t('en').voiceFailed(t('en').voiceEmpty))
  })
})

test('the transcript text never reaches the logs, even with debug logging on', async () => {
  await withVoiceBridge({ config: VOICE_ON, voiceKey: VOICE_KEY }, async ({ controller, host }) => {
    await controller.handleIncomingUpdate(voiceUpdate(1, 'voice'))
    const logs = JSON.stringify(storedLogs(host))
    assert.ok(!logs.includes('turn on the lights'), 'a log entry holds the transcript')
    assert.match(logs, /transcribe ok in \d+ ms: openai gpt-transcribe, 16 bytes/)
  })
})

test('voice settings: a save without them keeps them, a new key is stored, the panel sees only hasVoiceKey', async () => {
  await withVoiceBridge({ config: VOICE_ON, voiceKey: VOICE_KEY }, async ({ controller, manager, host }) => {
    assert.equal(controller.view().config.hasVoiceKey, true)
    await manager.saveConfig(saveInput(controller, { name: 'Renamed' }))
    const { config } = controller.view()
    assert.deepEqual([config.voiceEnabled, config.voiceProvider, config.voiceModel, config.hasVoiceKey], [true, 'openai', 'gpt-transcribe', true])
    assert.equal(host.data().secrets['voiceKey.b-voice001'], VOICE_KEY)

    await manager.saveConfig(saveInput(controller, { voiceProvider: 'openrouter', voiceModel: '', voiceApiKey: ' sk-new ' }))
    assert.equal(host.data().secrets['voiceKey.b-voice001'], 'sk-new')
    assert.equal(controller.view().config.voiceProvider, 'openrouter')
    assert.ok(!JSON.stringify(manager.getState()).includes('sk-new'), 'the panel state holds the voice key')
    assert.ok(!JSON.stringify(host.data().storage).includes('sk-new'), 'storage holds the voice key')

    await manager.saveConfig(saveInput(controller, { clearVoiceKey: true }))
    assert.equal(host.data().secrets['voiceKey.b-voice001'], undefined)
    assert.equal(controller.view().config.hasVoiceKey, false)
  })
})

test('a bridge stored without voice options reads them as off, OpenRouter, default model', async () => {
  await withVoiceBridge({}, async ({ controller }) => {
    const { config } = controller.view()
    assert.deepEqual([config.voiceEnabled, config.voiceProvider, config.voiceModel, config.hasVoiceKey], [false, 'openrouter', '', false])
  })
})

test('removing a bridge deletes its voice key', async () => {
  await withVoiceBridge({ config: VOICE_ON, voiceKey: VOICE_KEY }, async ({ worker, host }) => {
    await within(worker.request('bridge.remove', { bridgeId: 'b-voice001' }), 'remove')
    assert.equal(host.data().secrets['voiceKey.b-voice001'], undefined)
  })
})

const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 7)])

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-media-'))
  try {
    await run(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

// The Orca bot answers the Telegram message 'Show me the chart' with `reply`; `check` then sees
// what reached Telegram. The allowlist holds the sender unless `allowedUserIds` says otherwise.
async function replyWith(
  reply: string,
  check: (deps: ReturnType<typeof makeMockDeps>, manager: BridgeManager) => void | Promise<void>,
  setup: {
    allowedUserIds?: string
    telegram?: Partial<TelegramClient>
    renderTable?: BridgeDeps['renderTable']
  } = {}
): Promise<void> {
  const host = mockHost({
    capabilities: CAPABILITIES,
    secrets: { botToken: '123456:TEST_TOKEN' },
    settings: {
      enabled: false,
      defaultBot: 'Assistant',
      allowedUserIds: setup.allowedUserIds ?? '777888',
      proxyUrl: '',
      replyTimeoutSec: 300
    }
  })
  const deps = makeMockDeps({ telegram: setup.telegram })
  const baseReadSession = deps.orcaCli.readSession
  deps.orcaCli.readSession = async (sessionId, limit) => {
    const session = await baseReadSession(sessionId, limit)
    return {
      ...session,
      entries: session.entries.map((e) => (e.role === 'assistant' ? { ...e, text: reply } : e))
    }
  }
  const { manager, controller, worker } = await mountController(host, {
    telegram: deps.telegram,
    orcaCli: deps.orcaCli,
    pollIntervalMs: 1,
    renderTable: setup.renderTable ?? (async () => null)
  })
  try {
    await controller.handleIncomingUpdate(textUpdate(1, 777888, 'Show me the chart'))
    await check(deps, manager)
  } finally {
    await controller.dispose()
    await worker.deactivate()
  }
}

test('a reply with ![CPU](local png) sends the text without that line, then the PNG as a captioned photo', async () => {
  await withTempDir(async (dir) => {
    const png = path.join(dir, 'cpu.png')
    await fs.writeFile(png, PNG_BYTES)
    await replyWith(`CPU use today:\n\n![CPU](${png})\n\nPeak at noon.`, (deps) => {
      assert.deepEqual(deps.outbox, ['message:CPU use today:\n\nPeak at noon.', 'photo:cpu.png'])
      const [photo] = deps.sentPhotos
      assert.equal(photo.caption, 'CPU')
      assert.equal(photo.contentType, 'image/png')
      assert.equal(photo.bytes, PNG_BYTES.length)
      assert.equal(photo.url, undefined)
    })
  })
})

test('PDF and CSV references go out as documents; id_rsa, .env and .ssh files are refused by name only', async () => {
  await withTempDir(async (dir) => {
    const docs = path.join(dir, 'my docs')
    await fs.mkdir(path.join(dir, '.ssh'))
    await fs.mkdir(docs)
    await fs.writeFile(path.join(docs, 'report.pdf'), '%PDF-1.4 test')
    await fs.writeFile(path.join(dir, 'data.csv'), 'a,b\n1,2\n')
    await fs.writeFile(path.join(dir, 'id_rsa'), 'not a key')
    await fs.writeFile(path.join(dir, '.env'), 'TOKEN=x')
    await fs.writeFile(path.join(dir, '.ssh', 'notes.txt'), 'host x')
    const reply = [
      'Files:',
      `![Report](<${path.join(docs, 'report.pdf')}>)`,
      `![Data](${path.join(dir, 'data.csv')})`,
      `![Key](${path.join(dir, 'id_rsa')})`,
      `![Env](${path.join(dir, '.env')})`,
      `![Notes](${path.join(dir, '.ssh', 'notes.txt')})`
    ].join('\n')
    await replyWith(reply, (deps) => {
      assert.deepEqual(
        deps.sentDocuments.map((d) => [d.filename, d.contentType, d.caption]),
        [
          ['report.pdf', 'application/pdf', 'Report'],
          ['data.csv', 'text/csv', 'Data']
        ]
      )
      const en = t('en')
      assert.equal(deps.sentMessages[0].text, 'Files:')
      assert.equal(
        deps.sentMessages.at(-1)?.text,
        [
          en.attachmentFailed('id_rsa', en.attachmentNotAllowed),
          en.attachmentFailed('.env', en.attachmentNotAllowed),
          en.attachmentFailed('notes.txt', en.attachmentNotAllowed)
        ].join('\n')
      )
      assert.ok(
        deps.sentMessages.every((m) => !m.text.includes(dir)),
        'a Telegram message shows a local folder'
      )
    })
  })
})

test('a file named .png that is not a PNG is refused and its path stays in the log only', async () => {
  await withTempDir(async (dir) => {
    const fake = path.join(dir, 'chart.png')
    await fs.writeFile(fake, 'just text, no image signature')
    await replyWith(`![Chart](${fake})`, (deps, manager) => {
      assert.equal(deps.sentPhotos.length, 0)
      assert.equal(deps.sentDocuments.length, 0)
      const en = t('en')
      assert.deepEqual(
        deps.sentMessages.map((m) => m.text),
        [en.attachmentFailed('chart.png', en.attachmentNotImage)]
      )
      const warn = manager.getState().logs.find((e) => e.level === 'warn' && e.message.includes('chart.png'))
      assert.ok(warn?.details?.includes(fake), JSON.stringify(warn))
    })
  })
})

test('an https image URL is sent by URL, an https file URL as a document, an http URL stays as text', async () => {
  const reply = [
    'Links:',
    '![Logo](https://example.com/img/logo.png?size=2)',
    '![Sheet](https://example.com/files/q3.xlsx)',
    '![Old](http://example.com/old.png)'
  ].join('\n')
  await replyWith(reply, (deps) => {
    assert.deepEqual(deps.sentPhotos.map((p) => [p.url, p.caption]), [['https://example.com/img/logo.png?size=2', 'Logo']])
    assert.deepEqual(deps.sentDocuments.map((d) => [d.url, d.caption]), [['https://example.com/files/q3.xlsx', 'Sheet']])
    const text = deps.sentMessages[0].text
    assert.ok(text.includes('http://example.com/old.png'), text)
    assert.ok(!text.includes('https://'), text)
  })
})

test('a photo Telegram refuses is sent again as a document with its caption', async () => {
  await withTempDir(async (dir) => {
    const png = path.join(dir, 'wide.png')
    await fs.writeFile(png, PNG_BYTES)
    const photoTries: string[] = []
    await replyWith(
      `![Wide chart](${png})`,
      (deps) => {
        assert.deepEqual(photoTries, ['wide.png'])
        assert.deepEqual(
          deps.sentDocuments.map((d) => [d.filename, d.contentType, d.caption, d.bytes]),
          [['wide.png', 'image/png', 'Wide chart', PNG_BYTES.length]]
        )
        // Nothing failed, so no failure line; the document answers the user's message.
        assert.equal(deps.sentMessages.length, 0)
        assert.equal(deps.sentDocuments[0].replyToMessageId, 101)
      },
      {
        telegram: {
          async sendPhoto(_token, params) {
            photoTries.push(params.filename ?? '')
            throw new TelegramApiError('Bad Request: PHOTO_INVALID_DIMENSIONS', 400)
          }
        }
      }
    )
  })
})

test('attachments go out after the table images', async () => {
  await withTempDir(async (dir) => {
    const png = path.join(dir, 'cpu.png')
    await fs.writeFile(png, PNG_BYTES)
    const reply = `| Host | CPU |\n| --- | --- |\n| a | 5% |\n\n![CPU](${png})`
    await replyWith(
      reply,
      (deps) => {
        assert.deepEqual(
          deps.outbox.map((e) => (e.startsWith('message:') ? 'message' : e)),
          ['message', 'photo:table-1.png', 'photo:cpu.png']
        )
        assert.ok(!deps.sentMessages[0].text.includes('cpu.png'), deps.sentMessages[0].text)
      },
      { renderTable: async () => PNG_BYTES }
    )
  })
})

test('while the bridge is open to everyone local files are held back with one line; https URLs still go out', async () => {
  await withTempDir(async (dir) => {
    const png = path.join(dir, 'cpu.png')
    const pdf = path.join(dir, 'report.pdf')
    await fs.writeFile(png, PNG_BYTES)
    await fs.writeFile(pdf, '%PDF-1.4 test')
    const reply = `Done.\n![CPU](${png})\n![Report](${pdf})\n![Logo](https://example.com/logo.png)`
    await replyWith(
      reply,
      (deps, manager) => {
        assert.deepEqual(deps.sentPhotos.map((p) => p.url), ['https://example.com/logo.png'])
        assert.equal(deps.sentDocuments.length, 0)
        assert.deepEqual(
          deps.sentMessages.map((m) => m.text),
          ['Done.', t('en').attachmentNeedsAllowlist]
        )
        const warn = manager.getState().logs.find((e) => e.level === 'warn' && e.message.includes('local file attachment'))
        assert.ok(warn?.details?.includes(pdf), JSON.stringify(warn))
      },
      { allowedUserIds: '' }
    )
  })
})

test('the handoff tells the Orca bot how to attach files and still carries the Telegram marker', async () => {
  await replyWith('ok', (deps) => {
    const body = deps.sentToBots[0].body
    assert.equal(isTelegramOriginatedUserMessage(body), true)
    const lines = body.split('\n')
    assert.match(lines[1], /^Reply directly in this chat/)
    assert.match(lines[2], /!\[short caption\]\(absolute local path or https URL\)/)
    assert.equal(lines.at(-1), 'Show me the chart')
  })
})

test('Orca -> Telegram sync sends the attachments of a bot reply too', async () => {
  await withTempDir(async (dir) => {
    const pdf = path.join(dir, 'summary.pdf')
    await fs.writeFile(pdf, '%PDF-1.4 test')
    const boundChatId = 'orca-bound-media'
    let chatActivityAt = 1000
    const session: OrcaSessionRead = {
      orcaSessionId: boundChatId,
      state: 'done',
      entries: [{ kind: 'message', role: 'assistant', text: 'Old reply' }]
    }
    const host = mockHost({
      capabilities: CAPABILITIES,
      secrets: { botToken: '123456:TEST_TOKEN' },
      settings: {
        enabled: false,
        defaultBot: 'Assistant',
        allowedUserIds: '777888',
        proxyUrl: '',
        replyTimeoutSec: 300,
        syncOrcaOutbound: true
      },
      storage: {
        'tg.bindings': [
          { tgChatId: '777888', botId: 'bot-1', botName: 'Assistant', orcaChatId: boundChatId, updatedAt: 1000 }
        ]
      }
    })
    const deps = makeMockDeps({
      orcaCli: {
        async listBotChats() {
          return [
            {
              id: boundChatId,
              title: 'Bound Chat',
              lastActivityAt: chatActivityAt,
              lastAsked: null,
              lastSaid: null,
              home: false,
              self: false,
              closed: false
            }
          ]
        },
        async readSession() {
          return { ...session, entries: [...session.entries] }
        }
      }
    })
    const { controller, worker } = await mountController(host, {
      telegram: deps.telegram,
      orcaCli: deps.orcaCli,
      pollIntervalMs: 10
    })
    try {
      await controller.syncOrcaBoundChatsOnce()
      chatActivityAt = 2000
      session.entries.push({ kind: 'message', role: 'assistant', text: `Summary attached.\n\n![Summary](${pdf})` })
      await controller.syncOrcaBoundChatsOnce()
      assert.deepEqual(deps.outbox, ['message:Summary attached.', 'document:summary.pdf'])
      assert.equal(deps.sentDocuments[0].chatId, '777888')
      assert.equal(deps.sentDocuments[0].caption, 'Summary')
    } finally {
      await controller.dispose()
      await worker.deactivate()
    }
  })
})

// Roles as storage holds them (plain JSON).
function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

// A bridge stored after roles existed (default roles unless `config.roles` says otherwise). It knows
// its @username, so group lines addressed to it are read.
async function withRoles(
  config: Record<string, JsonValue>,
  run: (controller: BridgeRuntime, deps: ReturnType<typeof makeMockDeps>, manager: BridgeManager) => Promise<void>,
  orcaCli: Partial<OrcaCliRunner> = {}
): Promise<void> {
  const host = bridgesHost([{ id: 'b-roles001', token: '123456:TEST_TOKEN', config: { roles: asJson(defaultRoles()), ...config } }])
  const deps = makeMockDeps({ orcaCli })
  const { manager, controller, worker } = await mountController(host, {
    telegram: deps.telegram,
    orcaCli: deps.orcaCli,
    pollIntervalMs: 1
  })
  try {
    await controller.testConnection()
    await run(controller, deps, manager)
    assert.deepEqual(worker.refusals, [])
  } finally {
    await controller.dispose()
    await worker.deactivate()
  }
}

function buttonUpdate(updateId: number, userId: number, chatId: number, data: string): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id: userId, is_bot: false, first_name: 'User' },
      message: {
        message_id: 901,
        chat: chatId < 0 ? { id: chatId, type: 'supergroup' } : { id: chatId, type: 'private' },
        date: 2000
      },
      data
    }
  }
}

test('a bridge stored before roles keeps every listed id with Full access until roles are saved', async () => {
  const host = bridgesHost([{ id: 'b-old00001', token: '123456:TEST_TOKEN', config: { allowedUserIds: `777888, ${GROUP_ID}` } }])
  const deps = makeMockDeps()
  const { manager, controller, worker } = await mountController(host, { telegram: deps.telegram, orcaCli: deps.orcaCli })
  try {
    const { config } = controller.view()
    assert.deepEqual(config.roleAssignments, { '777888': 'full', [String(GROUP_ID)]: 'full' })
    assert.equal(config.rolesReviewed, false)
    assert.deepEqual(config.roles.map((r) => r.id), ['full', 'member', 'stranger'])

    // A save without roles keeps them as they are, still to be reviewed.
    await manager.saveConfig(saveInput(controller, { replyTimeoutSec: 120 }))
    assert.equal(controller.view().config.rolesReviewed, false)

    await manager.saveConfig(
      saveInput(controller, { roleAssignments: { '777888': 'full', [String(GROUP_ID)]: 'member', '5': 'no-such-role' } })
    )
    const saved = controller.view().config
    assert.equal(saved.rolesReviewed, true)
    assert.deepEqual(saved.roleAssignments, { '777888': 'full', [String(GROUP_ID)]: 'member' })
    const stored = (host.data().storage.bridges as { rolesReviewed: boolean }[])[0]
    assert.equal(stored.rolesReviewed, true)

    // A new bridge has nothing to review.
    const added = (await worker.request('bridge.add', {})) as { bridgeId: string; state: BridgeState }
    const fresh = added.state.bridges.find((b) => b.id === added.bridgeId)?.config
    assert.equal(fresh?.rolesReviewed, true)
    assert.equal(Object.keys(fresh?.roleAssignments ?? { x: 'x' }).length, 0)
  } finally {
    await worker.deactivate()
  }
})

test('an open bridge stored before roles gives Full access to everyone who already chatted in private', async () => {
  const binding = { botId: 'bot-1', botName: 'Assistant', orcaChatId: 'home-chat-1', updatedAt: 1000 }
  const host = bridgesHost([
    {
      id: 'b-open0001',
      token: '123456:TEST_TOKEN',
      config: { allowedUserIds: '' },
      state: {
        bindings: [
          { ...binding, tgChatId: '555', ownerUserId: '555' },
          // Someone who only wrote in a group is not carried over.
          { ...binding, tgChatId: String(GROUP_ID), ownerUserId: '556' }
        ]
      }
    }
  ])
  const deps = makeMockDeps()
  const { controller, worker } = await mountController(host, { telegram: deps.telegram, orcaCli: deps.orcaCli })
  try {
    assert.deepEqual(controller.view().config.roleAssignments, { '555': 'full' })
    assert.equal(controller.view().config.rolesReviewed, false)
    const stored = (host.data().storage.bridges as { roleAssignments: Record<string, string> }[])[0]
    assert.deepEqual(stored.roleAssignments, { '555': 'full' })

    await within(controller.handleIncomingUpdate(textUpdate(1, 555, '/run auto-1')), '/run from a former user')
    assert.deepEqual(deps.triggeredAutomations, ['auto-1'])

    // Anyone new on an open bridge is a Stranger.
    await within(controller.handleIncomingUpdate(textUpdate(2, 999, '/run auto-1')), '/run from a stranger')
    assert.equal(deps.triggeredAutomations.length, 1)
    assert.equal(deps.sentMessages.at(-1)?.text, t('en').notAllowedForRole)
  } finally {
    await controller.dispose()
    await worker.deactivate()
  }
})

test('a Member is refused /run, /chats, /sync, /bind, /home and group /new with one line in the chat language', async () => {
  await withRoles({ allowedUserIds: '42', roleAssignments: { '42': 'member' }, replyLanguage: 'pt-BR' }, async (controller, deps, manager) => {
    const refusal = t('pt-BR').notAllowedForRole
    const refused = ['/run auto-1', '/chats', '/sync on', '/bind home-chat-1', '/home']
    for (const [i, text] of refused.entries()) {
      await within(controller.handleIncomingUpdate(textUpdate(i + 1, 42, text)), text)
    }
    assert.deepEqual(deps.sentMessages.map((m) => m.text), refused.map(() => refusal))
    assert.equal(deps.triggeredAutomations.length, 0)
    assert.equal(controller.view().config.syncOrcaOutbound, false)
    assert.equal(deps.sentToBots.length, 0)
    const log = manager.getState().logs.find((e) => e.level === 'info' && e.message.startsWith('Refused /run'))
    assert.ok(log?.message.includes('role "Member"'), JSON.stringify(log))

    // /new is allowed in a private chat, not in a group.
    await within(controller.handleIncomingUpdate(textUpdate(10, 42, '/new')), 'private /new')
    assert.equal(deps.sentMessages.at(-1)?.text, t('pt-BR').contextReset('Assistant'))
    await within(controller.handleIncomingUpdate(groupUpdate(11, 42, '/new')), 'group /new')
    assert.equal(deps.sentMessages.at(-1)?.text, refusal)
    assert.equal(deps.sentMessages.at(-1)?.chatId, GROUP_ID)

    // /help lists only what the role may use.
    await within(controller.handleIncomingUpdate(textUpdate(12, 42, '/help')), '/help')
    const help = deps.sentMessages.at(-1)?.text ?? ''
    assert.ok(help.includes('/new') && help.includes('/status'), help)
    assert.ok(!help.includes('/run') && !help.includes('/chats') && !help.includes('/sync'), help)
  })
})

test('a refused button is answered with the refusal and does nothing', async () => {
  await withRoles({ allowedUserIds: '42', roleAssignments: { '42': 'member' } }, async (controller, deps) => {
    for (const [i, data] of ['r:auto-1', 's:on', 'b:home-chat-1', 'c:home'].entries()) {
      await within(controller.handleIncomingUpdate(buttonUpdate(i + 1, 42, 42, data)), data)
    }
    assert.deepEqual(
      deps.answeredCallbacks.map((a) => a.text),
      [1, 2, 3, 4].map(() => t('en').notAllowedForRole)
    )
    assert.equal(deps.triggeredAutomations.length, 0)
    assert.equal(controller.view().config.syncOrcaOutbound, false)
    assert.equal(controller.view().bindings.length, 0)
    assert.equal(deps.sentMessages.length, 0)

    // A button the role allows still acts.
    await within(controller.handleIncomingUpdate(buttonUpdate(5, 42, 42, 'c:new')), 'c:new')
    assert.equal(deps.answeredCallbacks.at(-1)?.text, t('en').contextResetToast)
  })
})

test("in a group a listed person's own role applies; an unlisted member gets the group's role", async () => {
  await withRoles(
    { allowedUserIds: `${GROUP_ID}, 42`, roleAssignments: { [String(GROUP_ID)]: 'member', '42': 'full' } },
    async (controller, deps) => {
      await within(controller.handleIncomingUpdate(groupUpdate(1, 42, '/run auto-1')), 'full /run')
      assert.deepEqual(deps.triggeredAutomations, ['auto-1'])

      await within(controller.handleIncomingUpdate(groupUpdate(2, 555, '/run auto-1')), 'member /run')
      assert.equal(deps.triggeredAutomations.length, 1)
      assert.equal(deps.sentMessages.at(-1)?.text, t('en').notAllowedForRole)

      const before = deps.sentMessages.length
      await within(controller.handleIncomingUpdate(groupUpdate(3, 555, '/status')), 'member /status')
      assert.equal(deps.sentMessages.length, before + 1)
      assert.notEqual(deps.sentMessages.at(-1)?.text, t('en').notAllowedForRole)
    }
  )
})

test("/run, Run buttons and /automations keep to the role's automation list; no Run buttons without run", async () => {
  const ops: BridgeRole = { id: 'ops', name: 'Ops', permissions: ['chat', 'automations', 'run'], prompt: '', runAutomationIds: ['auto-2'] }
  const viewer: BridgeRole = { id: 'viewer', name: 'Viewer', permissions: ['chat', 'automations'], prompt: '', runAutomationIds: null }
  const listAutomations = async () => [
    { id: 'auto-1', name: 'Daily backup', enabled: true, lastRunStatus: 'completed' },
    { id: 'auto-2', name: 'Nightly report', enabled: true, lastRunStatus: null }
  ]
  await withRoles(
    {
      allowedUserIds: '42, 43',
      roles: asJson([...defaultRoles(), ops, viewer]),
      roleAssignments: { '42': 'ops', '43': 'viewer' }
    },
    async (controller, deps) => {
      await within(controller.handleIncomingUpdate(textUpdate(1, 42, '/automations')), 'ops /automations')
      const list = deps.sentMessages.at(-1)
      assert.ok(list?.text.includes('auto-2') && !list.text.includes('auto-1'), list?.text)
      assert.deepEqual(
        (list?.replyMarkup?.inline_keyboard ?? []).flat().map((b) => b.callback_data),
        ['r:auto-2']
      )

      await within(controller.handleIncomingUpdate(textUpdate(2, 42, '/run auto-1')), '/run off the list')
      assert.equal(deps.sentMessages.at(-1)?.text, t('en').notAllowedForRole)
      await within(controller.handleIncomingUpdate(textUpdate(3, 42, '/run auto-2')), '/run on the list')
      assert.deepEqual(deps.triggeredAutomations, ['auto-2'])

      await within(controller.handleIncomingUpdate(buttonUpdate(4, 42, 42, 'r:auto-1')), 'button off the list')
      assert.equal(deps.answeredCallbacks.at(-1)?.text, t('en').notAllowedForRole)
      await within(controller.handleIncomingUpdate(buttonUpdate(5, 42, 42, 'r:auto-2')), 'button on the list')
      assert.deepEqual(deps.triggeredAutomations, ['auto-2', 'auto-2'])

      await within(controller.handleIncomingUpdate(textUpdate(6, 43, '/automations')), 'viewer /automations')
      const viewed = deps.sentMessages.at(-1)
      assert.ok(viewed?.text.includes('auto-1') && viewed.text.includes('auto-2'), viewed?.text)
      assert.equal(viewed?.replyMarkup, undefined)
    },
    { listAutomations }
  )
})

test('a role without chat is refused in a private chat and ignored in a group; its unknown commands too', async () => {
  const quiet: BridgeRole = { id: 'quiet', name: 'Quiet', permissions: ['status'], prompt: '', runAutomationIds: null }
  await withRoles(
    { allowedUserIds: `42, ${GROUP_ID}`, roles: asJson([...defaultRoles(), quiet]), roleAssignments: { '42': 'quiet' } },
    async (controller, deps) => {
      await within(controller.handleIncomingUpdate(textUpdate(1, 42, 'hello')), 'private message')
      await within(controller.handleIncomingUpdate(textUpdate(2, 42, '/whatever now')), 'unknown command')
      assert.deepEqual(deps.sentMessages.map((m) => m.text), [t('en').notAllowedForRole, t('en').notAllowedForRole])

      await within(controller.handleIncomingUpdate(groupUpdate(3, 42, '@demo_orca_bot hello')), 'group mention')
      assert.equal(deps.sentMessages.length, 2)
      assert.equal(deps.sentToBots.length, 0)

      await within(controller.handleIncomingUpdate(textUpdate(4, 42, '/status')), 'allowed command')
      assert.equal(deps.sentMessages.length, 3)
      assert.notEqual(deps.sentMessages.at(-1)?.text, t('en').notAllowedForRole)
    }
  )
})

test("the role's prompt reaches the Orca bot fenced with a nonce, before the user's words, never Telegram", async () => {
  const roles = defaultRoles().map((r) => (r.id === 'member' ? { ...r, prompt: 'Only discuss the garden.' } : r))
  await withRoles({ allowedUserIds: '42', roles: asJson(roles), roleAssignments: { '42': 'member' } }, async (controller, deps) => {
    await within(controller.handleIncomingUpdate(textUpdate(1, 42, 'what should I plant?')), 'message')
    const lines = deps.sentToBots[0].body.split('\n')
    assert.match(lines[0], /^Telegram message from user \(/)
    const open = lines.findIndex((l) => /\[role:[0-9a-f]+\]:$/.test(l))
    assert.ok(open > 0, lines.join('\n'))
    const nonce = /\[role:([0-9a-f]+)\]/.exec(lines[open])?.[1]
    assert.equal(lines[open + 1], 'Only discuss the garden.')
    assert.equal(lines[open + 2], `[/role:${nonce}]`)
    assert.equal(lines.at(-1), 'what should I plant?')
    assert.ok(deps.sentMessages.length > 0)
    assert.ok(!deps.sentMessages.some((m) => m.text.includes('garden') || m.text.includes('[role:')))
  })
})

test('menus: a default menu per access mode, one per assigned id, and a removed id loses its own', async () => {
  const host = bridgesHost([
    {
      id: 'b-menus001',
      token: '123456:TEST_TOKEN',
      config: {
        enabled: true,
        allowedUserIds: `42, 43, ${GROUP_ID}`,
        roles: asJson(defaultRoles()),
        roleAssignments: { '42': 'full', '43': 'member', [String(GROUP_ID)]: 'member' }
      },
      // 99 had a menu of its own before and no longer has a role.
      state: { commandScopes: ['42', '99'] }
    }
  ])
  // Each long poll stays open until the test answers it, as Telegram does while no message arrives.
  const polls: PromiseWithResolvers<TelegramUpdate[]>[] = []
  const deps = makeMockDeps({
    telegram: {
      getUpdates(_token, _params, options) {
        const poll = Promise.withResolvers<TelegramUpdate[]>()
        polls.push(poll)
        options?.signal?.addEventListener('abort', () => poll.resolve([]), { once: true })
        return poll.promise
      }
    }
  })
  const { manager, controller, worker } = await mountController(host, { telegram: deps.telegram, orcaCli: deps.orcaCli })
  const names = (commands: TelegramBotCommand[] | undefined) => (commands ?? []).map((c) => c.command)
  const menuOf = (chatId: string) => deps.chatMenus.filter((m) => String(m.chatId) === chatId)
  const scopes = () => [...((host.data().storage['tg.b-menus001.commandScopes'] as string[] | undefined) ?? [])].sort()
  try {
    await until(() => polls.length === 1, 'the first poll')
    // Restricted: people without a role of their own are Members.
    assert.deepEqual(names(deps.registeredCommands[0]), ['help', 'new', 'status'])
    assert.equal(deps.registeredMenus.length, 4)
    assert.deepEqual(menuOf('42').map((m) => m.languageCode), [null, 'pt', 'es', 'zh'])
    assert.ok(names(menuOf('42')[0]?.commands).includes('run'))
    assert.deepEqual(names(menuOf('43')[0]?.commands), ['help', 'new', 'status'])
    // In a group, /new needs the group permission, which Member does not have.
    assert.deepEqual(names(menuOf(String(GROUP_ID))[0]?.commands), ['help', 'status'])
    assert.deepEqual(
      deps.deletedChatMenus.map((m) => `${m.chatId}:${m.languageCode}`),
      ['99:null', '99:pt', '99:es', '99:zh']
    )
    assert.deepEqual(scopes(), ['-100500', '42', '43'].sort())

    // Open to everyone: the default menu is the Stranger's; 43 lost its role and its menu.
    await within(
      manager.saveConfig(
        saveInput(controller, { enabled: true, allowedUserIds: '', roleAssignments: { '42': 'full', [String(GROUP_ID)]: 'member' } })
      ),
      'save without 43'
    )
    polls[0].resolve([])
    await until(() => polls.length === 2, 'the menus sent again')
    assert.deepEqual(names(deps.registeredCommands[1]), ['help', 'new'])
    assert.deepEqual(deps.deletedChatMenus.slice(4).map((m) => String(m.chatId)), ['43', '43', '43', '43'])
    assert.deepEqual(scopes(), ['-100500', '42'].sort())
  } finally {
    await controller.dispose()
    await worker.deactivate()
  }
})

// Waits on real timers (the working line runs on them), a few ms at a time, for at most 2 s.
async function eventually(ready: () => boolean, label: string): Promise<void> {
  for (let waited = 0; waited < 2000; waited += 2) {
    if (ready()) return
    await pause(2)
  }
  throw new Error(`Gave up waiting for ${label}`)
}

// A bridge stored with the default roles (plus `config`) whose working line shows after 5 ms and is
// edited every 5 ms. `prepare` changes the mocks before the bridge starts.
async function withWorkingLine(
  config: Record<string, JsonValue>,
  prepare: (deps: ReturnType<typeof makeMockDeps>) => void,
  run: (controller: BridgeRuntime, deps: ReturnType<typeof makeMockDeps>) => Promise<void>,
  extra: Partial<BridgeDeps> = {}
): Promise<void> {
  const host = bridgesHost([{ id: 'b-working1', token: '123456:TEST_TOKEN', config: { roles: asJson(defaultRoles()), ...config } }])
  const deps = makeMockDeps()
  prepare(deps)
  const { controller, worker } = await mountController(host, {
    telegram: deps.telegram,
    orcaCli: deps.orcaCli,
    pollIntervalMs: 1,
    logFlushMs: 0,
    workingLineAfterMs: 5,
    workingLineEveryMs: 5,
    ...extra
  })
  try {
    await controller.testConnection()
    await run(controller, deps)
    assert.equal(worker.refusals.length, 0)
  } finally {
    await within(controller.dispose(), 'dispose')
    await worker.deactivate()
  }
}

// The Orca bot's answers wait until the test calls the returned release().
function holdAnswers(deps: ReturnType<typeof makeMockDeps>, answer?: string): () => void {
  const released = Promise.withResolvers<void>()
  const readSession = deps.orcaCli.readSession
  deps.orcaCli.readSession = async (sessionId, limit) => {
    await released.promise
    const session = await readSession(sessionId, limit)
    if (answer === undefined) return session
    return {
      ...session,
      entries: session.entries.map((e) => (e.kind === 'message' && e.role === 'assistant' ? { ...e, text: answer } : e))
    }
  }
  return () => released.resolve()
}

// The first send to the Orca bot fails as the CLI does when it cannot reach Orca; later ones work.
function failFirstSend(deps: ReturnType<typeof makeMockDeps>, message = 'orchestration send failed'): void {
  const sendToBot = deps.orcaCli.sendToBot
  let failed = false
  deps.orcaCli.sendToBot = async (params) => {
    if (failed) return sendToBot(params)
    failed = true
    // The CLI never started, so the message surely never reached Orca.
    throw new OrcaCliError(message, {
      kind: 'spawn',
      args: ['orchestration', 'send', '--to', 'bot:Assistant', '--chat', 'new', '--body-file', '-', '--json'],
      durationMs: 41
    })
  }
}

function buttonsOf(message: { replyMarkup?: TelegramInlineKeyboardMarkup } | undefined) {
  return (message?.replyMarkup?.inline_keyboard ?? []).flat()
}

test('a slow answer gets a working line, edited while waiting and deleted before the answer', async () => {
  let release = () => {}
  await withWorkingLine(
    { roleAssignments: { '777888': 'full' } },
    (deps) => {
      release = holdAnswers(deps)
    },
    async (controller, deps) => {
      const handled = controller.handleIncomingUpdate(textUpdate(1, 777888, 'slow question'))
      await eventually(() => deps.editedMessages.length >= 2, 'the working line edited twice')
      const line = deps.sentMessages[0]
      assert.match(line.text, /^⏳ Working… \d+s$/)
      assert.equal(line.replyToMessageId, 101)
      assert.ok(deps.editedMessages.every((e) => e.messageId === 901 && /^⏳ Working… \d+s$/.test(e.text)))

      release()
      await within(handled, 'the answer')
      assert.deepEqual(deps.deletedMessages, [{ chatId: 777888, messageId: 901 }])
      const deletedAt = deps.outbox.indexOf('delete:901')
      assert.ok(deletedAt >= 0 && deletedAt < deps.outbox.indexOf('message:Reply #1 from Assistant'), deps.outbox.join('\n'))
      assert.equal(deps.sentMessages.at(-1)?.text, 'Reply #1 from Assistant')
    }
  )
})

test('a fast answer gets no working line', async () => {
  await withWorkingLine(
    { roleAssignments: { '777888': 'full' } },
    () => {},
    async (controller, deps) => {
      await within(controller.handleIncomingUpdate(textUpdate(1, 777888, 'quick question')), 'the answer')
      assert.deepEqual(deps.sentMessages.map((m) => m.text), ['Reply #1 from Assistant'])
      assert.equal(deps.editedMessages.length + deps.deletedMessages.length, 0)
    },
    { workingLineAfterMs: 1500 }
  )
})

test('a NO_REPLY answer after the threshold deletes the working line and sends nothing else', async () => {
  let release = () => {}
  await withWorkingLine(
    { roleAssignments: { '777888': 'full' } },
    (deps) => {
      release = holdAnswers(deps, 'NO_REPLY')
    },
    async (controller, deps) => {
      const handled = controller.handleIncomingUpdate(textUpdate(1, 777888, 'just so you know'))
      await eventually(() => deps.sentMessages.length === 1, 'the working line')
      release()
      await within(handled, 'the quiet answer')
      assert.deepEqual(deps.deletedMessages, [{ chatId: 777888, messageId: 901 }])
      assert.equal(deps.sentMessages.length, 1)
      assert.match(deps.sentMessages[0].text, /^⏳ /)
    }
  )
})

test('a timeout gives the plain line in the chat language, no [Try again], and [Details] for Full access', async () => {
  await withWorkingLine(
    { roleAssignments: { '777888': 'full' }, replyLanguage: 'pt-BR' },
    (deps) => {
      deps.orcaCli.readSession = async () => {
        // The working line shows first, then the reply wait passes.
        await eventually(() => deps.sentMessages.length === 1, 'the working line')
        throw new DispatchTimeoutError('Timed out after 300s waiting for "Assistant" to finish.')
      }
    },
    async (controller, deps) => {
      await within(controller.handleIncomingUpdate(textUpdate(1, 777888, 'long job')), 'the timeout')
      const failure = deps.sentMessages.at(-1)
      assert.equal(failure?.text, t('pt-BR').errorTimeout)
      assert.deepEqual(buttonsOf(failure).map((b) => b.text), [t('pt-BR').detailsButton])
      assert.equal(deps.deletedMessages.length, 1)
      assert.ok(!deps.sentMessages.some((m) => m.text.includes('Timed out')))
    }
  )
})

test('a send that never reached the Orca bot gets [Try again]; [Details] sends the redacted cause', async () => {
  await withWorkingLine(
    { roleAssignments: { '777888': 'full' } },
    (deps) => failFirstSend(deps, 'orchestration send failed for bot123456:TEST_TOKEN'),
    async (controller, deps) => {
      await within(controller.handleIncomingUpdate(textUpdate(1, 777888, 'hello')), 'the failed send')
      const failure = deps.sentMessages.at(-1)
      assert.equal(failure?.text, t('en').errorOrcaUnreachable)
      assert.equal(failure?.replyToMessageId, 101)
      const buttons = buttonsOf(failure)
      assert.deepEqual(buttons.map((b) => b.text), [t('en').retryButton, t('en').detailsButton])
      assert.ok(!deps.sentMessages.some((m) => /not running|orchestration|TEST_TOKEN/.test(m.text)))
      const [retry, details] = buttons.map((b) => b.callback_data)
      assert.match(retry, /^x:/)
      assert.equal(details.slice(2), retry.slice(2))

      await within(controller.handleIncomingUpdate(buttonUpdate(2, 777888, 777888, details)), 'details')
      assert.equal(deps.sentMessages.at(-1)?.text, 'orchestration send failed for bot<redacted>')
      assert.equal(deps.sentMessages.at(-1)?.replyToMessageId, 101)

      await within(controller.handleIncomingUpdate(buttonUpdate(3, 777888, 777888, retry)), 'retry')
      assert.equal(deps.sentToBots.length, 1)
      assert.equal(lastBodyLine(deps), 'hello')
      assert.equal(deps.sentMessages.at(-1)?.text, 'Reply #1 from Assistant')

      // Used up: a second tap does not send it again.
      await within(controller.handleIncomingUpdate(buttonUpdate(4, 777888, 777888, retry)), 'second retry')
      assert.equal(deps.answeredCallbacks.at(-1)?.text, t('en').retryExpired)
      assert.equal(deps.sentToBots.length, 1)
    }
  )
})

test('a failure after the Orca bot got the message has no [Try again]', async () => {
  await withWorkingLine(
    { roleAssignments: { '777888': 'full' } },
    (deps) => {
      deps.orcaCli.readSession = async () => {
        throw new Error('session read broke')
      }
    },
    async (controller, deps) => {
      await within(controller.handleIncomingUpdate(textUpdate(1, 777888, 'hello')), 'the failure')
      assert.equal(deps.sentToBots.length, 1)
      const failure = deps.sentMessages.at(-1)
      assert.equal(failure?.text, t('en').errorGeneric)
      assert.deepEqual(buttonsOf(failure).map((b) => b.text), [t('en').detailsButton])
    }
  )
})

// A CLI that timed out while sending may still have delivered the message; retrying could run it twice.
test('a send that timed out has no [Try again]: the Orca bot may have the message', async () => {
  await withWorkingLine(
    { roleAssignments: { '777888': 'full' } },
    (deps) => {
      deps.orcaCli.sendToBot = async () => {
        throw new OrcaCliError('Orca CLI timed out after 30000ms', {
          kind: 'timeout',
          args: ['orchestration', 'send', '--to', 'bot:Assistant', '--chat', 'new', '--body-file', '-', '--json'],
          durationMs: 30000
        })
      }
    },
    async (controller, deps) => {
      await within(controller.handleIncomingUpdate(textUpdate(1, 777888, 'restart the payout worker')), 'the timed-out send')
      const failure = deps.sentMessages.at(-1)
      assert.equal(failure?.text, t('en').errorOrcaUnreachable)
      assert.deepEqual(buttonsOf(failure).map((b) => b.text), [t('en').detailsButton])
    }
  )
})

test('in a group only the sender may retry, and there is no [Details]', async () => {
  await withWorkingLine(
    { allowedUserIds: `${GROUP_ID}, 42`, roleAssignments: { [String(GROUP_ID)]: 'member', '42': 'full' } },
    (deps) => failFirstSend(deps),
    async (controller, deps) => {
      await within(controller.handleIncomingUpdate(groupUpdate(1, 42, '@demo_orca_bot hello')), 'the failed send')
      const failure = deps.sentMessages.at(-1)
      assert.equal(failure?.chatId, GROUP_ID)
      assert.equal(failure?.text, t('en').errorOrcaUnreachable)
      const buttons = buttonsOf(failure)
      assert.deepEqual(buttons.map((b) => b.text), [t('en').retryButton])
      const retry = buttons[0].callback_data

      // 555 is a Member here, a role with chat, but did not ask.
      await within(controller.handleIncomingUpdate(buttonUpdate(2, 555, GROUP_ID, retry)), 'retry by another member')
      assert.equal(deps.answeredCallbacks.at(-1)?.text, t('en').retryOnlySender)
      assert.equal(deps.sentToBots.length, 0)

      // A made-up [Details] for the same failure is refused in a group, even for Full access.
      await within(controller.handleIncomingUpdate(buttonUpdate(3, 42, GROUP_ID, `d:${retry.slice(2)}`)), 'details in a group')
      assert.equal(deps.answeredCallbacks.at(-1)?.text, t('en').notAllowedForRole)

      await within(controller.handleIncomingUpdate(buttonUpdate(4, 42, GROUP_ID, retry)), 'retry by the sender')
      assert.equal(deps.sentToBots.length, 1)
      assert.equal(deps.sentMessages.at(-1)?.text, 'Reply #1 from Assistant')
      assert.equal(deps.sentMessages.at(-1)?.chatId, GROUP_ID)
    }
  )
})

test('a Member gets no [Details], and [Try again] expires', async () => {
  await withWorkingLine(
    { allowedUserIds: '42', roleAssignments: { '42': 'member' } },
    (deps) => failFirstSend(deps),
    async (controller, deps) => {
      await within(controller.handleIncomingUpdate(textUpdate(1, 42, 'hello')), 'the failed send')
      const buttons = buttonsOf(deps.sentMessages.at(-1))
      assert.deepEqual(buttons.map((b) => b.text), [t('en').retryButton])
      const id = buttons[0].callback_data.slice(2)

      await within(controller.handleIncomingUpdate(buttonUpdate(2, 42, 42, `d:${id}`)), 'made-up details')
      assert.equal(deps.answeredCallbacks.at(-1)?.text, t('en').notAllowedForRole)

      await within(controller.handleIncomingUpdate(buttonUpdate(3, 42, 42, `x:${id}`)), 'expired retry')
      assert.equal(deps.answeredCallbacks.at(-1)?.text, t('en').retryExpired)
      assert.equal(deps.sentToBots.length, 0)
      assert.equal(deps.sentMessages.length, 1)
    },
    // No working line here, however slow the host, so the failure is the only message.
    { failedAnswerTtlMs: 0, workingLineAfterMs: 60_000 }
  )
})

test('an unaddressed group line gets no working line and no error message', async () => {
  await withWorkingLine(
    { allowedUserIds: `${GROUP_ID}, 42`, groupMode: 'all', roleAssignments: { [String(GROUP_ID)]: 'member', '42': 'full' } },
    (deps) => {
      deps.orcaCli.readSession = async () => {
        // No line can only be shown by letting the 5 ms threshold pass; the bridge's timers are real.
        await pause(30)
        throw new DispatchTimeoutError('Timed out after 300s waiting for "Assistant" to finish.')
      }
    },
    async (controller, deps) => {
      await within(controller.handleIncomingUpdate(groupUpdate(1, 42, 'just chatting among us')), 'the unaddressed line')
      assert.equal(deps.sentToBots.length, 1)
      assert.equal(deps.sentMessages.length + deps.editedMessages.length + deps.deletedMessages.length, 0)
    }
  )
})

test('/help and /status show the bound chat id only with bind and the sync state only with sync', async () => {
  await withRoles({ allowedUserIds: '42, 43', roleAssignments: { '42': 'member', '43': 'full' } }, async (controller, deps) => {
    await within(controller.handleIncomingUpdate(textUpdate(1, 42, '/help')), 'Member /help')
    const member = deps.sentMessages.at(-1)?.text ?? ''
    assert.ok(member.includes('Current bot: Assistant'), member)
    assert.ok(!member.includes('Current chat') && !member.includes('Two-way sync'), member)
    await within(controller.handleIncomingUpdate(textUpdate(2, 42, '/status')), 'Member /status')
    const memberStatus = deps.sentMessages.at(-1)?.text ?? ''
    assert.ok(memberStatus.includes('Target Orca bot: Assistant'), memberStatus)
    assert.ok(!memberStatus.includes('Bound chat ID') && !memberStatus.includes('Two-way sync'), memberStatus)

    await within(controller.handleIncomingUpdate(textUpdate(3, 43, '/help')), 'Full /help')
    const full = deps.sentMessages.at(-1)?.text ?? ''
    assert.ok(full.includes('Current chat') && full.includes('Two-way sync (Orca -> TG): off'), full)
    await within(controller.handleIncomingUpdate(textUpdate(4, 43, '/status')), 'Full /status')
    const fullStatus = deps.sentMessages.at(-1)?.text ?? ''
    assert.ok(fullStatus.includes('Bound chat ID') && fullStatus.includes('Two-way sync (Orca -> TG): off'), fullStatus)
  })
})

// A bridge stored after roles existed, whose audit entries are written at once; `now` is the
// audit clock and `storage` seeds the host (e.g. stored audit entries).
async function withAudit(
  config: Record<string, JsonValue>,
  run: (ctx: {
    controller: BridgeRuntime
    deps: ReturnType<typeof makeMockDeps>
    manager: BridgeManager
    host: MockHost
    worker: TestWorker
  }) => Promise<void>,
  options: {
    now?: () => number
    storage?: Record<string, JsonValue>
    setup?: (deps: ReturnType<typeof makeMockDeps>) => void
  } = {}
): Promise<void> {
  const host = bridgesHost(
    [{ id: 'b-audit001', token: '123456:TEST_TOKEN', config: { roles: asJson(defaultRoles()), ...config } }],
    { storage: options.storage }
  )
  const deps = makeMockDeps()
  options.setup?.(deps)
  const { manager, controller, worker } = await mountController(host, {
    telegram: deps.telegram,
    orcaCli: deps.orcaCli,
    pollIntervalMs: 1,
    logFlushMs: 0,
    ...(options.now ? { now: options.now } : {})
  })
  try {
    await controller.testConnection()
    await run({ controller, deps, manager, host, worker })
    assert.deepEqual(worker.refusals, [])
  } finally {
    await controller.dispose()
    await worker.deactivate()
  }
}

function storedAudit(host: MockHost): AuditEntry[] {
  return (host.data().storage['tg.audit'] ?? []) as AuditEntry[]
}

function seededAudit(i: number, at: number, fields: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: `s${i}`,
    at,
    bridgeId: 'b-audit001',
    source: 'telegram',
    userId: '42',
    userLabel: '@joao',
    chatId: '42',
    roleName: 'Full access',
    action: 'run',
    target: 'Daily backup',
    result: 'done',
    ...fields
  }
}

test('the audit records done commands and buttons with role and target, and never the title or message text', async () => {
  await withAudit({ allowedUserIds: '42', roleAssignments: { '42': 'full' } }, async ({ controller, host }) => {
    const steps: TelegramUpdate[] = [
      textUpdate(1, 42, '/run auto-1'),
      textUpdate(2, 42, '/sync on'),
      textUpdate(3, 42, '/new'),
      textUpdate(4, 42, '/home'),
      textUpdate(5, 42, '/bind home-chat-1'),
      textUpdate(6, 42, '/rename Secret plans'),
      textUpdate(7, 42, 'my private words'),
      buttonUpdate(8, 42, 42, 'r:auto-1'),
      buttonUpdate(9, 42, 42, 's:off'),
      buttonUpdate(10, 42, 42, 'c:new'),
      buttonUpdate(11, 42, 42, 'c:home'),
      buttonUpdate(12, 42, 42, 'b:home-chat-1')
    ]
    for (const update of steps) await within(controller.handleIncomingUpdate(update), `update ${update.update_id}`)

    const entries = [...storedAudit(host)].reverse()
    assert.deepEqual(
      entries.map((e) => [e.action, e.target ?? '', e.result]),
      [
        ['run', 'Daily backup', 'done'],
        ['sync', 'on', 'done'],
        ['new', '', 'done'],
        ['home', 'home-chat-1', 'done'],
        ['bind', 'home-chat-1', 'done'],
        ['rename', '', 'done'],
        ['run', 'Daily backup', 'done'],
        ['sync', 'off', 'done'],
        ['new', '', 'done'],
        ['home', 'home-chat-1', 'done'],
        ['bind', 'home-chat-1', 'done']
      ]
    )
    for (const e of entries) {
      assert.deepEqual([e.bridgeId, e.source, e.userId, e.userLabel, e.chatId, e.roleName], ['b-audit001', 'telegram', '42', 'User (42)', '42', 'Full access'])
    }
    const stored = JSON.stringify(storedAudit(host))
    assert.ok(!stored.includes('Secret plans') && !stored.includes('my private words'), stored)
  })
})

test('a role refusal is recorded as refused with the command, the button kind, or chat for a message', async () => {
  const muted: BridgeRole = { id: 'muted', name: 'Muted', permissions: [], prompt: '', runAutomationIds: null }
  await withAudit(
    { allowedUserIds: '42, 43', roles: asJson([...defaultRoles(), muted]), roleAssignments: { '42': 'member', '43': 'muted' } },
    async ({ controller, host }) => {
      await within(controller.handleIncomingUpdate(textUpdate(1, 42, '/run auto-1')), '/run')
      await within(controller.handleIncomingUpdate(buttonUpdate(2, 42, 42, 's:on')), 's:on')
      await within(controller.handleIncomingUpdate(textUpdate(3, 43, 'my private words')), 'message')
      assert.deepEqual(
        [...storedAudit(host)].reverse().map((e) => [e.action, e.target, e.result, e.roleName, e.userId]),
        [
          ['refused', '/run', 'refused', 'Member', '42'],
          ['refused', 's:', 'refused', 'Member', '42'],
          ['refused', 'chat', 'refused', 'Muted', '43']
        ]
      )
      assert.ok(!JSON.stringify(storedAudit(host)).includes('my private words'))
    }
  )
})

test('Try again and Details taps are recorded as done', async () => {
  await withAudit(
    { allowedUserIds: '42', roleAssignments: { '42': 'full' } },
    async ({ controller, deps, host }) => {
      await within(controller.handleIncomingUpdate(textUpdate(1, 42, 'first try')), 'failed message')
      const buttons = buttonsOf(deps.sentMessages.at(-1))
      const details = buttons.find((b) => b.callback_data?.startsWith('d:'))?.callback_data ?? ''
      const retry = buttons.find((b) => b.callback_data?.startsWith('x:'))?.callback_data ?? ''
      assert.ok(details && retry, JSON.stringify(buttons))
      await within(controller.handleIncomingUpdate(buttonUpdate(2, 42, 42, details)), 'details tap')
      await within(controller.handleIncomingUpdate(buttonUpdate(3, 42, 42, retry)), 'retry tap')
      assert.deepEqual(
        [...storedAudit(host)].reverse().map((e) => [e.action, e.result]),
        [
          ['details', 'done'],
          ['retry', 'done']
        ]
      )
    },
    { setup: (deps) => failFirstSend(deps) }
  )
})

test('panel saves record access, roles and token changes without the token; Allow and bridges too; a no-op save nothing', async () => {
  await withAudit({ allowedUserIds: '42', roleAssignments: { '42': 'member' } }, async ({ controller, manager, host }) => {
    await manager.saveConfig(saveInput(controller, {}))
    assert.equal(manager.listAudit({}).total, 0)

    await manager.saveConfig(saveInput(controller, { allowedUserIds: '42, 43' }))
    await manager.saveConfig(saveInput(controller, { allowedUserIds: '' }))
    await manager.saveConfig(saveInput(controller, { roleAssignments: { '42': 'full' } }))
    await manager.saveConfig(
      saveInput(controller, { roles: defaultRoles().map((r) => (r.id === 'member' ? { ...r, name: 'Helper' } : r)) })
    )
    await manager.saveConfig(saveInput(controller, { botToken: '654321:NEW_SECRET_TOKEN' }))
    await manager.saveConfig(saveInput(controller, { clearToken: true }))
    // Turning the group notice on is a setting, not an audited change.
    await manager.saveConfig(saveInput(controller, { groupAuditNotice: true }))
    assert.equal(controller.view().config.groupAuditNotice, true)
    assert.equal((host.data().storage.bridges as { groupAuditNotice: boolean }[])[0].groupAuditNotice, true)
    await controller.allowUserId('77')

    const added = await manager.addBridge('Second')
    await manager.removeBridge(added)

    assert.deepEqual(
      [...storedAudit(host)].reverse().map((e) => [e.action, e.target, e.source, e.bridgeId]),
      [
        ['access', 'added 43', 'panel', 'b-audit001'],
        ['access', 'open; removed 42, 43', 'panel', 'b-audit001'],
        ['roles', 'assignments', 'panel', 'b-audit001'],
        ['roles', 'name: Helper', 'panel', 'b-audit001'],
        ['token', 'changed', 'panel', 'b-audit001'],
        ['token', 'cleared', 'panel', 'b-audit001'],
        ['allow', '77', 'panel', 'b-audit001'],
        ['bridgeAdded', 'Second', 'panel', added],
        ['bridgeRemoved', 'Second', 'panel', added]
      ]
    )
    // The removed bridge's entries stay.
    assert.equal(manager.listAudit({ bridgeId: added }).total, 2)
    assert.ok(!JSON.stringify(storedAudit(host)).includes('NEW_SECRET_TOKEN'))
    assert.ok(storedAudit(host).every((e) => e.userId === undefined && e.result === 'done'))
  })
})

test('a roles save names each changed role and what changed, never the prompt text', async () => {
  await withAudit({ allowedUserIds: '42', roleAssignments: { '42': 'member' } }, async ({ controller, manager, host }) => {
    const roles = () => controller.view().config.roles
    const prompt = 'Always answer about project Falcon in pirate speak'
    await manager.saveConfig(saveInput(controller, { roles: roles().map((r) => (r.id === 'member' ? { ...r, prompt } : r)) }))
    assert.deepEqual(storedAudit(host).map((e) => [e.action, e.target]), [['roles', 'prompt: Member']])
    assert.ok(!JSON.stringify(storedAudit(host)).includes('Falcon'))

    await manager.saveConfig(
      saveInput(controller, {
        roles: roles().map((r) =>
          r.id === 'member' ? { ...r, permissions: [...r.permissions, 'run' as const], runAutomationIds: ['auto-1'] } : r
        )
      })
    )
    const qa: BridgeRole = { id: 'qa', name: 'QA', permissions: ['chat'], prompt: '', runAutomationIds: null }
    await manager.saveConfig(saveInput(controller, { roles: [...roles(), qa] }))
    await manager.saveConfig(saveInput(controller, { roles: roles().filter((r) => r.id !== 'qa') }))
    assert.deepEqual(
      [...storedAudit(host)].reverse().map((e) => [e.action, e.target]),
      [
        ['roles', 'prompt: Member'],
        ['roles', 'permissions: Member'],
        ['roles', 'added: QA'],
        ['roles', 'removed: QA']
      ]
    )
  })
})

test('the audit keeps 90 days and at most 2000 entries, newest first', async () => {
  const start = Date.UTC(2026, 10, 1)
  let clock = start
  const day = 24 * 60 * 60 * 1000
  const seeded = [
    ...Array.from({ length: 2100 }, (_, i) => seededAudit(i, start - i * 1000)),
    seededAudit(9999, start - 91 * day, { target: 'too old' })
  ]
  await withAudit(
    { allowedUserIds: '42' },
    async ({ controller, manager, host }) => {
      const loaded = manager.listAudit({})
      assert.equal(loaded.total, 2000)
      assert.equal(loaded.entries.length, 500)

      clock = start + 1000
      await controller.allowUserId('77')
      const stored = storedAudit(host)
      assert.equal(stored.length, 2000)
      assert.deepEqual([stored[0].action, stored[0].at], ['allow', start + 1000])
      assert.equal(stored.at(-1)?.id, 's1998')
      assert.ok(!stored.some((e) => e.target === 'too old'))

      clock = start + 91 * day
      assert.equal(manager.listAudit({}).total, 0)
      await controller.allowUserId('78')
      assert.deepEqual(storedAudit(host).map((e) => e.target), ['78'])
    },
    { now: () => clock, storage: { 'tg.audit': asJson(seeded) } }
  )
})

test('the group notice goes only to groups, only when on, only for done shared-state actions, in the chat language', async () => {
  await withAudit(
    {
      allowedUserIds: `${GROUP_ID}, 42`,
      roleAssignments: { [String(GROUP_ID)]: 'member', '42': 'full' },
      replyLanguage: 'es'
    },
    async ({ controller, deps, manager }) => {
      const notice = t('es').groupNotice
      const member = 'Member (42)'
      const notices = () => deps.sentMessages.filter((m) => /^(Member|User) \(\d+\) /.test(m.text))

      await within(controller.handleIncomingUpdate(groupUpdate(1, 42, '/new')), 'group /new while off')
      assert.equal(notices().length, 0)

      await manager.saveConfig(saveInput(controller, { groupAuditNotice: true }))
      await within(controller.handleIncomingUpdate(groupUpdate(2, 42, '/new')), 'group /new')
      await within(controller.handleIncomingUpdate(groupUpdate(3, 42, '/sync off')), 'group /sync off')
      await within(controller.handleIncomingUpdate(groupUpdate(4, 42, '/run auto-1')), 'group /run')
      await within(controller.handleIncomingUpdate(buttonUpdate(5, 42, GROUP_ID, 'c:home')), 'group c:home')
      await within(controller.handleIncomingUpdate(groupUpdate(6, 42, '/rename Team plans')), 'group /rename')
      assert.deepEqual(notices().map((m) => [m.chatId, m.text]), [
        [GROUP_ID, notice.new(member)],
        [GROUP_ID, notice.sync(member, false)],
        [GROUP_ID, notice.run(member, 'Daily backup')],
        [GROUP_ID, notice.home('User (42)')],
        [GROUP_ID, notice.rename(member)]
      ])
      assert.ok(!notices().some((m) => m.text.includes('Team plans')))

      // No notice in a private chat, for a refusal, or for what changes nothing shared.
      await within(controller.handleIncomingUpdate(textUpdate(7, 42, '/new')), 'private /new')
      await within(controller.handleIncomingUpdate(groupUpdate(8, 555, '/sync on')), 'refused group /sync')
      assert.equal(deps.sentMessages.at(-1)?.text, t('es').notAllowedForRole)
      await within(controller.handleIncomingUpdate(groupUpdate(9, 555, '/status')), 'group /status')
      assert.equal(notices().length, 5)
    }
  )
})

test('listAudit filters by bridge, action and result, newest first, at most 500 with the total; exportAudit is quoted CSV', async () => {
  const now = Date.UTC(2026, 10, 1)
  const seeded = Array.from({ length: 600 }, (_, i) =>
    seededAudit(i, now - (600 - i) * 1000, {
      bridgeId: i % 2 === 0 ? 'b-audit001' : 'b-gone0001',
      ...(i % 3 === 0 ? { action: 'refused', target: '/run', result: 'refused' } : {})
    })
  )
  seeded.push(seededAudit(600, now - 100, { bridgeId: 'b-quote001', target: 'say "hi", ok' }))
  await withAudit(
    { allowedUserIds: '42' },
    async ({ manager, worker }) => {
      const all = await worker.request('bridge.listAudit', {})
      assert.equal(all.total, 601)
      assert.equal(all.entries.length, 500)
      assert.equal(all.entries[0].id, 's600')
      assert.ok(all.entries.every((e, i) => i === 0 || all.entries[i - 1].at >= e.at))

      const one = manager.listAudit({ bridgeId: 'b-audit001' })
      assert.equal(one.total, 300)
      assert.ok(one.entries.every((e) => e.bridgeId === 'b-audit001'))
      assert.equal(manager.listAudit({ result: 'refused' }).total, 200)
      assert.equal(manager.listAudit({ action: 'run' }).total, 401)
      const both = await worker.request('bridge.listAudit', { bridgeId: 'b-gone0001', result: 'refused' })
      assert.equal(both.total, 100)

      const csv = await worker.request('bridge.exportAudit', { bridgeId: 'b-quote001' })
      assert.match(csv.fileName, /^telegram-bridge-audit-\d{8}-\d{6}\.csv$/)
      const lines = csv.text.trimEnd().split('\n')
      assert.equal(lines[0], '"time","bridge","source","user id","user","chat","role","action","target","result"')
      assert.equal(
        lines[1],
        `"${new Date(now - 100).toISOString()}","b-quote001","telegram","42","@joao","42","Full access","run","say ""hi"", ok","done"`
      )
      assert.equal(lines.length, 2)
      const named = await worker.request('bridge.exportAudit', { bridgeId: 'b-audit001' })
      assert.ok(named.text.split('\n')[1].includes('"Bridge 1"'), named.text.slice(0, 300))
    },
    { now: () => now, storage: { 'tg.audit': asJson(seeded) } }
  )
})

// Names next to the listed IDs in the editor (specs/SPEC-known-names.md).
const NAMES_BRIDGE = 'b-names001'

function storedNames(host: MockHost): Record<string, string> | undefined {
  return host.data().storage[`tg.${NAMES_BRIDGE}.knownNames`] as Record<string, string> | undefined
}

// Writes of the names key, so a repeated name can be shown to write nothing.
function namesWrites(host: MockHost): number {
  return host.calls.filter(
    (c) => c.method.startsWith('storage.') && c.method !== 'storage.get' && JSON.stringify(c.params).includes(`${NAMES_BRIDGE}.knownNames`)
  ).length
}

async function withNamesBridge(
  options: {
    config?: Record<string, JsonValue>
    knownNames?: Record<string, string>
    telegram?: Partial<TelegramClient>
    debugLogging?: boolean
  },
  run: (ctx: { controller: BridgeRuntime; host: MockHost; deps: ReturnType<typeof makeMockDeps> }) => Promise<void>
): Promise<void> {
  const host = bridgesHost(
    [
      {
        id: NAMES_BRIDGE,
        token: '123456:TEST_TOKEN',
        config: { roles: asJson(defaultRoles()), ...options.config },
        state: options.knownNames ? { knownNames: options.knownNames } : {}
      }
    ],
    { debugLogging: options.debugLogging }
  )
  const deps = makeMockDeps({ telegram: options.telegram })
  const { controller, worker } = await mountBridge(host, deps)
  try {
    await run({ controller, host, deps })
    assert.deepEqual(worker.refusals, [])
  } finally {
    await within(controller.dispose(), 'dispose')
    await worker.deactivate()
  }
}

function personUpdate(
  updateId: number,
  from: { id: number; first_name: string; last_name?: string; username?: string }
): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: 100 + updateId,
      from: { is_bot: false, ...from },
      chat: { id: from.id, type: 'private' },
      date: 1000,
      text: '/help'
    }
  }
}

test('a listed person leaves @username or First Last, a listed group its title; an unlisted sender nothing', async () => {
  await withNamesBridge({ config: { allowedUserIds: `111, 222, ${GROUP_ID}` } }, async ({ controller, host }) => {
    await controller.testConnection()
    await within(controller.handleIncomingUpdate(personUpdate(1, { id: 111, first_name: 'Ana', username: 'ana_dev' })), 'ana')
    await within(controller.handleIncomingUpdate(personUpdate(2, { id: 222, first_name: 'Bruno', last_name: 'Costa' })), 'bruno')
    // an unlisted member's line in a listed group: the group's title only
    await within(controller.handleIncomingUpdate(groupUpdate(3, 999, 'hello all')), 'group line')
    await within(controller.handleIncomingUpdate(personUpdate(4, { id: 555, first_name: 'Stranger', username: 'stranger' })), 'stranger')

    const expected = { '111': '@ana_dev', '222': 'Bruno Costa', [String(GROUP_ID)]: 'Team' }
    assert.deepEqual(storedNames(host), expected)
    assert.deepEqual(controller.view().knownNames, expected)

    // the same name again writes nothing; a new @username replaces the old name
    const writes = namesWrites(host)
    await within(controller.handleIncomingUpdate(personUpdate(5, { id: 111, first_name: 'Ana', username: 'ana_dev' })), 'ana again')
    assert.equal(namesWrites(host), writes)
    await within(controller.handleIncomingUpdate(personUpdate(6, { id: 111, first_name: 'Ana', username: 'ana_new' })), 'ana renamed')
    assert.equal(storedNames(host)?.['111'], '@ana_new')
  })
})

test('on an open bridge only people with a role leave a name, strangers none', async () => {
  await withNamesBridge(
    { config: { allowedUserIds: '', roleAssignments: { '111': 'full' } } },
    async ({ controller, host }) => {
      await within(controller.handleIncomingUpdate(personUpdate(1, { id: 555, first_name: 'Stranger' })), 'stranger')
      assert.equal(storedNames(host), undefined)
      await within(controller.handleIncomingUpdate(personUpdate(2, { id: 111, first_name: 'Ana' })), 'ana')
      assert.deepEqual(storedNames(host), { '111': 'Ana' })
    }
  )
})

test('on connect each listed ID without a name is looked up once; a refusal stays blank, logged at debug only', async () => {
  const lookups: (number | string)[] = []
  await withNamesBridge(
    {
      config: { enabled: true, allowedUserIds: '111, 222, 333' },
      knownNames: { '222': '@bob' },
      debugLogging: true,
      telegram: {
        getUpdates: scriptedGetUpdates([[]]),
        async getChat(_token, chatId) {
          lookups.push(chatId)
          if (chatId === 111) return { id: 111, type: 'private', first_name: 'Ana', username: 'ana_dev' }
          throw new TelegramApiError('Forbidden: bot was blocked by the user', 403)
        }
      }
    },
    async ({ controller, host }) => {
      await until(() => storedNames(host)?.['111'] !== undefined, 'the looked-up name')
      await until(() => controller.view().status === 'connected', 'connected')
      // more polls and turns: the refused ID is not asked again in this run
      for (let i = 0; i < 50; i++) await nextTurn()
      assert.deepEqual(lookups, [111, 333])
      assert.deepEqual(storedNames(host), { '111': '@ana_dev', '222': '@bob' })
      assert.deepEqual(controller.view().knownNames, { '111': '@ana_dev', '222': '@bob' })
      const logs = storedLogs(host)
      assert.equal(logs.filter((e) => e.level === 'warn' || e.level === 'error').length, 0)
      assert.ok(logs.some((e) => e.level === 'debug' && /No name for Telegram ID 333/.test(e.message)))
    }
  )
})

test('after a save the listed IDs without a name are looked up, at most 50, and a removed ID drops its name', async () => {
  const lookups: (number | string)[] = []
  const many = Array.from({ length: 60 }, (_, i) => String(2001 + i))
  await withNamesBridge(
    {
      config: { allowedUserIds: '111' },
      knownNames: { '111': '@ana_dev' },
      telegram: {
        async getChat(_token, chatId) {
          lookups.push(chatId)
          if (chatId === -1001) return { id: -1001, type: 'supergroup', title: 'Ops Team' }
          throw new TelegramApiError('Bad Request: chat not found', 400)
        }
      }
    },
    async ({ controller, host }) => {
      await within(controller.saveConfig(saveInput(controller, { allowedUserIds: ['111', '-1001', ...many].join(', ') })), 'save')
      await until(() => lookups.length === 50 && storedNames(host)?.['-1001'] !== undefined, '50 lookups')
      for (let i = 0; i < 50; i++) await nextTurn()
      // the known 111 is not asked; the cap stops at 50 of the 61 missing
      assert.deepEqual(lookups, [-1001, ...many.slice(0, 49).map(Number)])
      assert.deepEqual(storedNames(host), { '111': '@ana_dev', '-1001': 'Ops Team' })

      // the next save retries the ones still missing, once each
      await within(controller.saveConfig(saveInput(controller, {})), 'save again')
      await until(() => lookups.length === 100, 'the retry run')
      for (let i = 0; i < 50; i++) await nextTurn()
      assert.equal(lookups.length, 100)

      // removing an ID drops its name at that save
      await within(controller.saveConfig(saveInput(controller, { allowedUserIds: '-1001' })), 'save without 111')
      assert.deepEqual(storedNames(host), { '-1001': 'Ops Team' })
      assert.deepEqual(controller.view().knownNames, { '-1001': 'Ops Team' })
    }
  )
})
