import {
  assert,
  mockHost,
  mount,
  test,
  type MockHostOptions,
  type TestPanel
} from 'orca/testing'
import * as panel from './panel'
import type {
  AuditEntry,
  AuditQuery,
  BridgeConfig,
  BridgeState,
  BridgeView,
  ChatBinding,
  FocusedBot,
  SaveConfigInput
} from './protocol'
import { defaultRoles, type BridgeRole } from './roles'

const SELECT_BOT_HINT = 'Select a bot in the left sidebar to see its Telegram bridge.'
const ALL_BRIDGES_NOTE = 'Showing all bridges: Orca did not say which bot is selected.'
const TABS = { label: 'Telegram Bridge sections' }

type BridgeOverrides = Partial<Omit<BridgeView, 'config'>> & { config?: Partial<BridgeConfig> }

function botFocus(name: string): FocusedBot {
  return { kind: 'bot', bot: { id: `bot-${name}`, name } }
}

// What the worker answers for the bot selected in Orca's sidebar; `selectInSidebar` changes it.
let focused: FocusedBot = botFocus('Assistant')

// A mock host whose worker answers `bridge.focusedBot` with the sidebar selection, Assistant by
// default; the test's own `requests` answer the rest.
function panelHost(options: MockHostOptions = {}, focus: FocusedBot = botFocus('Assistant')) {
  focused = focus
  return mockHost({ ...options, requests: { 'bridge.focusedBot': () => focused, ...options.requests } })
}

// As a click in Orca's sidebar: Orca tells the panel the focus changed, and the panel asks the worker.
async function selectInSidebar(view: TestPanel, next: FocusedBot): Promise<void> {
  focused = next
  await view.emit('workspace.changed', {
    context: next.kind === 'none' ? null : { workspaceId: 'folder:1', branch: '', displayName: '', terminals: [] }
  })
}

function binding(tgChatId: string, botName: string, orcaChatId: string | null): ChatBinding {
  return { tgChatId, botId: `bot-${botName}`, botName, orcaChatId, updatedAt: Date.now() }
}

function makeBridge(id: string, overrides: BridgeOverrides = {}): BridgeView {
  const { config, ...rest } = overrides
  const name = rest.name ?? 'Main'
  const allowedUserIds = config?.allowedUserIds ?? '123456'
  return {
    id,
    name,
    status: 'connected',
    polling: true,
    botUsername: 'demo_orca_bot',
    botDisplayName: 'DemoBot',
    lastError: null,
    lastBlockedUserId: null,
    lastPollAt: Date.now(),
    bindings: [binding('123456', 'Assistant', 'chat-abc')],
    telegramCaps: { canJoinGroups: true, canReadAllGroupMessages: true },
    knownNames: {},
    ...rest,
    config: {
      id,
      name,
      hasToken: true,
      enabled: true,
      orcaBot: 'Assistant',
      // As the worker reads a stored bridge without the field: restricted when an ID is listed.
      restricted: allowedUserIds.split(/[\s,;]+/).some((id) => /^-?\d+$/.test(id)),
      allowedUserIds,
      roles: defaultRoles(),
      roleAssignments: {},
      rolesReviewed: true,
      proxyUrl: 'http://127.0.0.1:7890',
      replyTimeoutSec: 300,
      syncOrcaOutbound: false,
      replyLanguage: 'en',
      allowGroups: false,
      groupMode: 'addressed',
      groupReply: 'mentioned',
      groupAuditNotice: false,
      voiceEnabled: false,
      voiceProvider: 'openrouter',
      voiceModel: '',
      hasVoiceKey: false,
      ...config
    }
  }
}

function makeState(overrides: Partial<BridgeState> = {}): BridgeState {
  return {
    bridges: [makeBridge('b1')],
    bots: [
      { id: 'bot-1', name: 'Assistant', specialty: 'Workspace assistant', agent: 'claude' },
      { id: 'bot-2', name: 'CIWatcher', specialty: 'CI', agent: 'claude' },
      { id: 'bot-3', name: 'DevHelper', specialty: '', agent: 'codex' }
    ],
    global: { debugLogging: false },
    logs: [
      {
        id: '1',
        at: Date.now(),
        level: 'info',
        scope: 'telegram',
        bridgeId: 'b1',
        message: 'Connected to Telegram as @demo_orca_bot.'
      }
    ],
    logTotal: 1,
    ...overrides
  }
}

// @ci_bot is pinned to CIWatcher and restricted; @dev_bot is pinned to the first Orca bot
// (Assistant) and open. DevHelper has no bridge.
function twoBridges(): BridgeView[] {
  return [
    makeBridge('ci', {
      name: 'CI',
      botUsername: 'ci_bot',
      config: { orcaBot: 'CIWatcher', allowedUserIds: '111' },
      bindings: [binding('111', 'CIWatcher', 'chat-ci')]
    }),
    makeBridge('dev', {
      name: 'Dev',
      botUsername: 'dev_bot',
      config: { orcaBot: '', allowedUserIds: '' },
      bindings: [binding('222', 'Assistant', 'chat-dev'), binding('333', 'Assistant', null)]
    })
  ]
}

function withBridge(state: BridgeState, bridgeId: string, patch: BridgeOverrides): BridgeState {
  return {
    ...state,
    bridges: state.bridges.map((b) =>
      b.id === bridgeId
        ? { ...b, ...patch, config: { ...b.config, ...patch.config } }
        : b
    )
  }
}

async function openEditor(view: TestPanel, bridgeId: string): Promise<void> {
  await view.press({ testId: `edit:${bridgeId}` })
}

async function openAdvanced(view: TestPanel): Promise<void> {
  await view.toggle({ type: 'Collapsible', label: 'Advanced' })
}

function cardLabels(view: TestPanel): (string | undefined)[] {
  return view.findAll({ type: 'Card' }).map((c) => c.label)
}

test('renders bridge status, allows saving config, and handles unauthorized user banner', async () => {
  let currentState = makeState({ bridges: [makeBridge('b1', { lastBlockedUserId: '999000' })] })
  const allowed: Array<{ bridgeId: string; userId: string }> = []
  const saved: SaveConfigInput[] = []
  const tested: Array<{ bridgeId: string }> = []
  const host = panelHost({
    requests: {
      'bridge.getState': () => currentState,
      'bridge.saveConfig': (input: SaveConfigInput) => {
        saved.push(input)
        currentState = withBridge(currentState, 'b1', {
          config: { syncOrcaOutbound: input.syncOrcaOutbound }
        })
        return currentState
      },
      'bridge.allowUserId': (input: { bridgeId: string; userId: string }) => {
        allowed.push(input)
        currentState = withBridge(currentState, 'b1', {
          lastBlockedUserId: null,
          config: { allowedUserIds: `123456, ${input.userId}` }
        })
        return currentState
      },
      'bridge.testConnection': (input: { bridgeId: string }) => {
        tested.push(input)
        return { ok: true, username: 'demo_orca_bot', botId: 100000001, state: currentState }
      }
    }
  })

  const view = await mount(panel, { host })
  assert.ok(view.find({ text: 'Connected' }))
  assert.ok(view.find({ text: 'Allow 999000' }))

  await view.press({ text: 'Allow 999000' })
  assert.deepEqual(allowed, [{ bridgeId: 'b1', userId: '999000' }])
  assert.equal(view.find({ text: 'Allow 999000' }), null)

  await openEditor(view, 'b1')
  // the allowed ID is a new row; the worker gives it Member
  assert.equal(view.valueOf({ label: 'Telegram ID 2' }), '999000')
  assert.equal(view.valueOf({ label: 'Role for Telegram ID 2' }), 'member')
  await view.press({ text: 'Save' })
  assert.equal(saved.length, 1)
  assert.equal(saved[0].bridgeId, 'b1')
  assert.equal(saved[0].allowedUserIds, '123456, 999000')
  assert.deepEqual(saved[0].roleAssignments, { '123456': 'member', '999000': 'member' })
  assert.equal('botToken' in saved[0], false)
  // Bot on/off lives only in the bridge card; saving the form must not touch it.
  assert.equal('enabled' in saved[0], false)
  assert.ok(view.find({ text: 'Settings saved.' }))

  await openEditor(view, 'b1')
  await view.press({ text: 'Test connection' })
  assert.deepEqual(tested, [{ bridgeId: 'b1' }])
  assert.ok(view.find({ text: /Connected to @demo_orca_bot/ }))

  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test("only the selected bot's bridge, chats and logs show; selecting another bot switches them", async () => {
  const at = Date.now()
  const state = makeState({
    bridges: twoBridges(),
    logTotal: 3,
    logs: [
      { id: 'c', at, level: 'info', scope: 'telegram', bridgeId: 'ci', message: 'CI polled' },
      { id: 'd', at, level: 'info', scope: 'telegram', bridgeId: 'dev', message: 'Dev polled' },
      { id: 'p', at, level: 'info', scope: 'config', message: 'Plugin started' }
    ]
  })
  const host = panelHost({ requests: { 'bridge.getState': () => state } }, botFocus('CIWatcher'))
  const view = await mount(panel, { host })
  assert.deepEqual(cardLabels(view), ['@ci_bot'])
  assert.equal(view.find({ type: 'Card', label: '@ci_bot' })!.props.description, '→ CIWatcher')
  assert.equal(view.findAll({ label: 'Active' }).length, 1)
  // the card offers only Edit; Remove lives in the editor
  assert.equal(view.find({ testId: 'remove:ci' }), null)
  assert.equal(view.find({ text: SELECT_BOT_HINT }), null)

  await view.select(TABS, 'bindings')
  assert.ok(view.find({ label: 'TG 111 -> CIWatcher' }))
  assert.equal(view.find({ label: 'TG 222 -> Assistant' }), null)

  await view.select(TABS, 'logs')
  assert.ok(view.find({ label: 'CI polled' }))
  assert.equal(view.find({ label: 'Dev polled' }), null)
  assert.equal(view.find({ label: 'Plugin started' }), null)
  // the logs are this bridge's: no bridge filter, and no bridge name on each entry
  assert.equal(view.find({ label: 'Bridge' }), null)
  assert.equal(view.find({ label: 'CI polled' })!.props.description, 'INFO · telegram')
  assert.ok(view.find({ text: 'Showing 1 of 1 entries' }))

  // the bridge stored with '' follows the first Orca bot, Assistant
  await selectInSidebar(view, botFocus('Assistant'))
  assert.ok(view.find({ label: 'Dev polled' }))
  assert.equal(view.find({ label: 'CI polled' }), null)
  await view.select(TABS, 'bindings')
  assert.ok(view.find({ label: 'TG 222 -> Assistant' }))
  assert.equal(view.find({ label: 'TG 111 -> CIWatcher' }), null)
  await view.select(TABS, 'setup')
  assert.deepEqual(cardLabels(view), ['@dev_bot'])
  assert.equal(view.find({ type: 'Card', label: '@dev_bot' })!.props.description, '→ Assistant')
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('selecting another bot closes the open editor', async () => {
  const host = panelHost({ requests: { 'bridge.getState': () => makeState({ bridges: twoBridges() }) } }, botFocus('CIWatcher'))
  const view = await mount(panel, { host })
  await openEditor(view, 'ci')
  assert.ok(view.find({ type: 'Card', label: 'Edit @ci_bot' }))
  await selectInSidebar(view, botFocus('Assistant'))
  assert.equal(view.find({ type: 'Card', label: 'Edit @ci_bot' }), null)
  assert.equal(view.find({ type: 'Card', label: 'Edit @dev_bot' }), null)
  await selectInSidebar(view, botFocus('CIWatcher'))
  assert.equal(view.find({ type: 'Card', label: 'Edit @ci_bot' }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('outside a bot only the hint shows; bridges whose bot is gone are listed to edit', async () => {
  const state = makeState({
    bridges: [
      ...twoBridges(),
      makeBridge('gone', { name: 'Gone', botUsername: 'gone_bot', config: { orcaBot: 'OldBot' } })
    ]
  })
  const host = panelHost({ requests: { 'bridge.getState': () => state } }, botFocus('CIWatcher'))
  const view = await mount(panel, { host })
  assert.deepEqual(cardLabels(view), ['@ci_bot'])

  // a project workspace: the worker answers none
  await selectInSidebar(view, { kind: 'none' })
  assert.ok(view.find({ type: 'EmptyState', label: SELECT_BOT_HINT }))
  assert.equal(view.find({ type: 'Tabs' }), null)
  assert.equal(view.find({ text: 'Add bridge' }), null)
  // @ci_bot and @dev_bot ('' with bots listed) have a bot; only the bridge to OldBot is lost
  assert.deepEqual(cardLabels(view), ['@gone_bot'])
  assert.ok(view.find({ type: 'Heading', text: 'Bridges without an Orca bot' }))
  await openEditor(view, 'gone')
  assert.ok(view.find({ text: 'Orca bot: OldBot. This Telegram bot talks only to it.' }))
  assert.ok(view.find({ testId: 'remove:gone' }))

  // back on a bot, its bridge shows again
  await selectInSidebar(view, botFocus('CIWatcher'))
  assert.deepEqual(cardLabels(view), ['@ci_bot'])
  assert.equal(view.find({ text: SELECT_BOT_HINT }), null)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('without lost bridges the hint is all a non-bot focus shows', async () => {
  const host = panelHost({ requests: { 'bridge.getState': () => makeState({ bridges: twoBridges() }) } }, { kind: 'none' })
  const view = await mount(panel, { host })
  assert.ok(view.find({ type: 'EmptyState', label: SELECT_BOT_HINT }))
  assert.equal(view.findAll({ type: 'Card' }).length, 0)
  assert.equal(view.find({ type: 'Tabs' }), null)
  assert.equal(view.find({ text: 'Refresh' }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('an answer for an earlier focus is dropped when the focus moved on', async () => {
  const state = makeState({ bridges: twoBridges() })
  const slow = Promise.withResolvers<void>()
  let asked = 0
  const host = mockHost({
    requests: {
      'bridge.getState': () => state,
      'bridge.focusedBot': async (): Promise<FocusedBot> => {
        asked += 1
        // setup asks first (Assistant); the next answer (CIWatcher) comes after a later click's.
        if (asked === 1) return botFocus('Assistant')
        if (asked === 2) {
          await slow.promise
          return botFocus('CIWatcher')
        }
        return botFocus('DevHelper')
      }
    }
  })
  const view = await mount(panel, { host })
  assert.deepEqual(cardLabels(view), ['@dev_bot'])
  const context = { workspaceId: 'folder:1', branch: '', displayName: '', terminals: [] }
  const first = view.emit('workspace.changed', { context })
  const second = view.emit('workspace.changed', { context })
  slow.resolve()
  await Promise.all([first, second])
  assert.equal(asked, 3)
  assert.ok(view.find({ type: 'EmptyState', label: 'No Telegram bridge for DevHelper' }))
  assert.equal(view.find({ type: 'Card', label: '@ci_bot' }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('when Orca cannot say which bot is selected every bridge shows, with the bridge filter', async () => {
  const at = Date.now()
  const saved: SaveConfigInput[] = []
  const state = makeState({
    bridges: twoBridges(),
    logTotal: 3,
    logs: [
      { id: 'c', at, level: 'info', scope: 'telegram', bridgeId: 'ci', message: 'CI polled' },
      { id: 'd', at, level: 'info', scope: 'telegram', bridgeId: 'dev', message: 'Dev polled' },
      { id: 'p', at, level: 'info', scope: 'config', message: 'Plugin started' }
    ]
  })
  const host = panelHost(
    {
      requests: {
        'bridge.getState': () => state,
        'bridge.saveConfig': (input: SaveConfigInput) => {
          saved.push(input)
          return state
        }
      }
    },
    { kind: 'unknown', reason: 'This Orca does not name the focused workspace.' }
  )
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: ALL_BRIDGES_NOTE }))
  assert.equal(view.find({ text: SELECT_BOT_HINT }), null)
  assert.deepEqual(cardLabels(view), ['@ci_bot', '@dev_bot'])
  assert.deepEqual(
    view.findAll({ type: 'Card' }).map((c) => c.props.description),
    ['→ CIWatcher', '→ first Orca bot']
  )
  assert.equal(view.findAll({ label: 'Active' }).length, 2)
  assert.ok(view.find({ text: 'Add bridge' }))

  // the editor keeps the bridge on its own bot
  await openEditor(view, 'dev')
  await view.press({ text: 'Save' })
  assert.equal(saved[0].orcaBot, '')

  await view.select(TABS, 'bindings')
  const headings = view
    .findAll({ type: 'Heading' })
    .filter((h) => h.props.level === 3)
    .map((h) => h.text)
  assert.deepEqual(headings, ['@ci_bot', '@dev_bot'])

  await view.select(TABS, 'logs')
  assert.ok(view.find({ text: 'Showing 3 of 3 entries' }))
  assert.equal(view.find({ label: 'Dev polled' })!.props.description, 'INFO · telegram · @dev_bot')
  await view.select({ label: 'Bridge' }, 'dev')
  assert.ok(view.find({ label: 'Dev polled' }))
  assert.equal(view.find({ label: 'CI polled' }), null)
  assert.equal(view.find({ label: 'Plugin started' }), null)
  assert.ok(view.find({ text: 'Showing 1 of 3 entries' }))
  await view.select({ label: 'Bridge' }, '__plugin__')
  assert.ok(view.find({ label: 'Plugin started' }))
  assert.equal(view.find({ label: 'Dev polled' }), null)
  await view.select({ label: 'Bridge' }, 'all')
  assert.ok(view.find({ text: 'Showing 3 of 3 entries' }))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('a worker that cannot answer the focus also shows every bridge', async () => {
  // No bridge.focusedBot handler: the request fails like an older worker's would.
  const host = mockHost({ requests: { 'bridge.getState': () => makeState({ bridges: twoBridges() }) } })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: ALL_BRIDGES_NOTE }))
  assert.deepEqual(cardLabels(view), ['@ci_bot', '@dev_bot'])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('Active switches the shown bridge only', async () => {
  let current = makeState({ bridges: twoBridges() })
  const sent: Array<{ bridgeId: string; enabled: boolean }> = []
  const host = panelHost({
    requests: {
      'bridge.getState': () => current,
      'bridge.setEnabled': (input: { bridgeId: string; enabled: boolean }) => {
        sent.push(input)
        current = withBridge(current, input.bridgeId, {
          status: input.enabled ? 'connected' : 'stopped',
          polling: input.enabled,
          config: { enabled: input.enabled }
        })
        return current
      }
    }
  })
  const view = await mount(panel, { host })
  await view.toggle({ testId: 'active:dev' })
  assert.deepEqual(sent, [{ bridgeId: 'dev', enabled: false }])
  assert.equal(view.valueOf({ testId: 'active:dev' }), false)
  assert.equal(view.find({ testId: 'active:ci' }), null)
  assert.ok(view.find({ text: 'Paused' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a bot without a bridge shows only Add bridge, which pins the new bridge to it and opens its editor', async () => {
  let current = makeState({ bridges: twoBridges() })
  const added: Array<{ name?: string; orcaBot?: string }> = []
  const host = panelHost(
    {
      requests: {
        'bridge.getState': () => current,
        'bridge.add': (input: { name?: string; orcaBot?: string }) => {
          added.push(input)
          const fresh = makeBridge('b3', {
            name: 'Bridge 3',
            status: 'needs_token',
            polling: false,
            botUsername: null,
            bindings: [],
            config: { hasToken: false, enabled: false, orcaBot: input.orcaBot ?? '', allowedUserIds: '' }
          })
          current = { ...current, bridges: [...current.bridges, fresh] }
          return { bridgeId: 'b3', state: current }
        }
      }
    },
    botFocus('DevHelper')
  )
  const view = await mount(panel, { host })
  assert.equal(view.findAll({ type: 'Card' }).length, 0)
  assert.ok(view.find({ type: 'EmptyState', label: 'No Telegram bridge for DevHelper' }))
  assert.equal(view.findAll({ type: 'Button', text: 'Add bridge' }).length, 1)
  await view.select(TABS, 'bindings')
  assert.ok(view.find({ type: 'EmptyState', label: 'No active Telegram chats yet' }))
  await view.select(TABS, 'logs')
  assert.ok(view.find({ type: 'EmptyState', label: 'No activity logs yet' }))
  await view.select(TABS, 'setup')

  await view.press({ text: 'Add bridge' })
  assert.deepEqual(added, [{ orcaBot: 'DevHelper' }])
  // before the token is checked the bot has no @username, so the card says what it is
  assert.equal(view.find({ type: 'Card', label: 'New Telegram bot' })!.props.description, '→ DevHelper')
  assert.ok(view.find({ type: 'Card', label: 'Edit New Telegram bot' }))
  assert.equal(view.find({ text: 'Add bridge' }), null)
  assert.equal(view.find({ label: 'Name' }), null)
  // a new bridge has no token yet, so it cannot be tested or switched on
  assert.equal(view.find({ text: 'Test connection' })!.disabled, true)
  assert.equal(view.find({ testId: 'active:b3' })!.props.disabled, true)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('Save sends the edited bridge id and never the on/off state or a name; it pins a bridge on "" to the bot', async () => {
  const state = makeState({ bridges: twoBridges() })
  const saved: SaveConfigInput[] = []
  const host = panelHost({
    requests: {
      'bridge.getState': () => state,
      'bridge.saveConfig': (input: SaveConfigInput) => {
        saved.push(input)
        return state
      }
    }
  })
  const view = await mount(panel, { host })
  await openEditor(view, 'dev')
  // the bot's @username names it; there is no Name field and no name in the payload
  assert.equal(view.find({ label: 'Name' }), null)
  await view.press({ text: 'Save' })
  assert.deepEqual(saved, [
    {
      bridgeId: 'dev',
      orcaBot: 'Assistant',
      restricted: false,
      allowedUserIds: '',
      roleAssignments: {},
      roles: defaultRoles(),
      proxyUrl: 'http://127.0.0.1:7890',
      replyTimeoutSec: 300,
      syncOrcaOutbound: false,
      replyLanguage: 'en',
      allowGroups: false,
      groupMode: 'addressed',
      groupReply: 'mentioned',
      groupAuditNotice: false,
      voiceEnabled: false,
      voiceProvider: 'openrouter',
      voiceModel: ''
    }
  ])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a duplicate token refused by the worker shows in feedback and keeps the editor', async () => {
  const state = makeState({ bridges: twoBridges() })
  const host = panelHost({
    requests: {
      'bridge.getState': () => state,
      'bridge.saveConfig': () => {
        throw new Error('This bot token is already used by bridge "CI".')
      }
    }
  })
  const view = await mount(panel, { host })
  await openEditor(view, 'dev')
  await view.type({ label: 'Telegram bot token' }, '123456:DUPLICATE')
  await view.press({ text: 'Save' })
  assert.ok(view.find({ text: /already used by bridge "CI"/ }))
  assert.equal(view.find({ text: 'Settings saved.' }), null)
  assert.ok(view.find({ type: 'Card', label: 'Edit @dev_bot' }))
  // the typed token stays so the user can fix it
  assert.equal(view.valueOf({ label: 'Telegram bot token' }), '123456:DUPLICATE')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('Remove sits in the editor, needs a second press, and leaves the bot with Add bridge', async () => {
  let current = makeState({ bridges: twoBridges() })
  const removed: Array<{ bridgeId: string }> = []
  const host = panelHost(
    {
      requests: {
        'bridge.getState': () => current,
        'bridge.remove': (input: { bridgeId: string }) => {
          removed.push(input)
          current = { ...current, bridges: current.bridges.filter((b) => b.id !== input.bridgeId) }
          return current
        }
      }
    },
    botFocus('CIWatcher')
  )
  const view = await mount(panel, { host })

  await openEditor(view, 'ci')
  await view.press({ testId: 'remove:ci' })
  assert.ok(view.find({ testId: 'confirm-remove:ci' }))
  await view.press({ testId: 'keep:ci' })
  assert.equal(view.find({ testId: 'confirm-remove:ci' }), null)

  await view.press({ testId: 'remove:ci' })
  assert.deepEqual(removed, [])
  assert.equal(view.find({ testId: 'confirm-remove:ci' })!.text, 'Confirm remove')
  await view.press({ testId: 'confirm-remove:ci' })
  assert.deepEqual(removed, [{ bridgeId: 'ci' }])
  assert.equal(view.find({ type: 'Card', label: '@ci_bot' }), null)
  assert.equal(view.find({ type: 'Card', label: 'Edit @ci_bot' }), null)
  assert.ok(view.find({ type: 'EmptyState', label: 'No Telegram bridge for CIWatcher' }))
  assert.ok(view.find({ text: 'Removed @ci_bot.' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test("Chats shows the shown bridge's chats and resets on that bridge", async () => {
  const state = makeState({ bridges: twoBridges() })
  const resets: Array<{ bridgeId: string; tgChatId: string }> = []
  const host = panelHost({
    requests: {
      'bridge.getState': () => state,
      'bridge.resetBinding': (input: { bridgeId: string; tgChatId: string }) => {
        resets.push(input)
        return state
      }
    }
  })
  const view = await mount(panel, { host })
  await view.select(TABS, 'bindings')
  // one bridge's chats need no heading per bridge
  assert.equal(view.findAll({ type: 'Heading' }).filter((h) => h.props.level === 3).length, 0)
  assert.ok(view.find({ label: 'TG 222 -> Assistant' }))
  assert.ok(view.find({ label: 'TG 333 -> Assistant' }))
  assert.equal(view.find({ label: 'TG 111 -> CIWatcher' }), null)

  await view.press({ testId: 'reset:dev:222' })
  assert.deepEqual(resets, [{ bridgeId: 'dev', tgChatId: '222' }])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('the editor names the Orca bot as text: no bot select and no Auto option', async () => {
  const state = makeState()
  const host = panelHost({ requests: { 'bridge.getState': () => state } })
  const view = await mount(panel, { host })
  await openEditor(view, 'b1')
  assert.equal(view.find({ label: 'Orca bot (this Telegram bot talks only to it)' }), null)
  assert.equal(view.find({ text: /Auto-select/ }), null)
  // The only Selects are the people rows' role pickers: none offers Orca bots or Auto.
  const offersBots = view
    .findAll({ type: 'Select' })
    .some((s) => (s.props.options as { label: string }[]).some((o) => /Assistant|Auto-select/.test(o.label)))
  assert.equal(offersBots, false)
  assert.ok(view.find({ text: 'Orca bot: Assistant. This Telegram bot talks only to it.' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('the reply language select shows the saved language and saves the chosen one', async () => {
  const saved: SaveConfigInput[] = []
  const state = makeState({ bridges: [makeBridge('b1', { config: { replyLanguage: 'zh-CN' } })] })
  const host = panelHost({
    requests: {
      'bridge.getState': () => state,
      'bridge.saveConfig': (input: SaveConfigInput) => {
        saved.push(input)
        return state
      }
    }
  })
  const view = await mount(panel, { host })
  await openEditor(view, 'b1')
  await openAdvanced(view)
  assert.equal(view.valueOf({ label: 'Telegram reply language' }), 'zh-CN')
  const options = view.find({ label: 'Telegram reply language' })!.props.options as { value: string }[]
  assert.deepEqual(options.map((o) => o.value), ['auto', 'en', 'pt-BR', 'es', 'zh-CN'])

  await view.select({ label: 'Telegram reply language' }, 'es')
  await view.press({ text: 'Save' })
  assert.equal(saved[0].replyLanguage, 'es')
  // A save closes the editor; the card is back and the note is shown.
  assert.equal(view.find({ label: 'Telegram reply language' }), null)
  assert.equal(view.find({ text: 'Save' }), null)
  assert.ok(view.findAll({ type: 'Callout' }).some((c) => c.props.title === 'Settings saved.'))

  await openEditor(view, 'b1')
  await openAdvanced(view)
  await view.select({ label: 'Telegram reply language' }, 'auto')
  await view.press({ text: 'Save' })
  assert.equal(saved[1].replyLanguage, 'auto')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

// A failed save must stay where the user is looking: the editor stays open and says why by its buttons.
test('a failed save keeps the editor open and shows the reason next to the buttons', async () => {
  const state = makeState({ bridges: [makeBridge('b1')] })
  const host = panelHost({
    requests: {
      'bridge.getState': () => state,
      'bridge.saveConfig': () => {
        throw new Error('This bot token is already used by the bridge "Other".')
      }
    }
  })
  const view = await mount(panel, { host })
  await openEditor(view, 'b1')
  await view.press({ text: 'Save' })
  assert.ok(view.find({ text: 'Save' }), 'the editor is still open')
  assert.ok(view.find({ type: 'Text', text: /already used by the bridge "Other"/ }))
  // Once, by the buttons: not repeated in a callout at the top of the panel.
  assert.equal(view.findAll({ type: 'Callout' }).some((c) => /already used/.test(String(c.props.title))), false)
  // Cancel and reopen: the old reason is gone.
  await view.press({ text: 'Cancel' })
  await openEditor(view, 'b1')
  assert.equal(view.find({ type: 'Text', text: /already used by the bridge "Other"/ }), null)
  await view.unmount()
})

function savingHost(state: BridgeState, saved: SaveConfigInput[]) {
  return panelHost({
    requests: {
      'bridge.getState': () => state,
      'bridge.saveConfig': (input: SaveConfigInput) => {
        saved.push(input)
        // Answer like the worker: the state after the save, or the editor reloads the old values.
        const bridge = state.bridges.find((b) => b.id === input.bridgeId)!
        bridge.config = {
          ...bridge.config,
          voiceEnabled: input.voiceEnabled ?? bridge.config.voiceEnabled,
          voiceProvider: input.voiceProvider ?? bridge.config.voiceProvider,
          voiceModel: input.voiceModel ?? bridge.config.voiceModel,
          hasVoiceKey: bridge.config.hasVoiceKey || Boolean(input.voiceApiKey)
        }
        return state
      }
    }
  })
}

test('voice options are hidden while off and shown after turning Voice messages on', async () => {
  const view = await mount(panel, { host: savingHost(makeState(), []) })
  await openEditor(view, 'b1')
  assert.equal(view.find({ label: 'Transcription provider' }), null)
  assert.equal(view.find({ label: 'Transcription API key' }), null)
  await view.toggle({ label: 'Voice messages' })
  assert.equal(view.valueOf({ label: 'Transcription provider' }), 'openrouter')
  // the model is a rare option, so it sits under Advanced
  assert.equal(view.find({ label: 'Transcription model' }), null)
  await openAdvanced(view)
  assert.ok(view.find({ label: 'Transcription model' }))
  assert.ok(view.find({ text: /sent to OpenRouter to be transcribed/ }))
  assert.ok(view.find({ text: /Add an API key/ }))
  await view.type({ label: 'Transcription API key' }, 'sk-or-abc')
  assert.equal(view.find({ text: /Add an API key/ }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('Save sends the voice fields and the typed key, then clears the key field', async () => {
  const saved: SaveConfigInput[] = []
  const view = await mount(panel, { host: savingHost(makeState(), saved) })
  await openEditor(view, 'b1')
  await view.toggle({ label: 'Voice messages' })
  await view.select({ label: 'Transcription provider' }, 'openai')
  await openAdvanced(view)
  await view.type({ label: 'Transcription model' }, 'whisper-1')
  await view.type({ label: 'Transcription API key' }, '  sk-secret  ')
  await view.press({ text: 'Save' })
  assert.equal(saved[0].voiceEnabled, true)
  assert.equal(saved[0].voiceProvider, 'openai')
  assert.equal(saved[0].voiceModel, 'whisper-1')
  assert.equal(saved[0].voiceApiKey, 'sk-secret')
  // The saved key is never shown again: the reopened editor starts with an empty key field.
  await openEditor(view, 'b1')
  assert.equal(view.valueOf({ label: 'Transcription API key' }), '')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('Save leaves out the voice key when the key field is empty', async () => {
  const saved: SaveConfigInput[] = []
  const state = makeState({
    bridges: [makeBridge('b1', { config: { voiceEnabled: true, hasVoiceKey: true } })]
  })
  const view = await mount(panel, { host: savingHost(state, saved) })
  await openEditor(view, 'b1')
  await view.press({ text: 'Save' })
  assert.equal(saved[0].voiceEnabled, true)
  assert.equal('voiceApiKey' in saved[0], false)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('switching the provider changes the model and key placeholders', async () => {
  const state = makeState({ bridges: [makeBridge('b1', { config: { voiceEnabled: true } })] })
  const view = await mount(panel, { host: savingHost(state, []) })
  await openEditor(view, 'b1')
  await openAdvanced(view)
  assert.equal(view.find({ label: 'Transcription model' })!.props.placeholder, 'openai/whisper-large-v3')
  assert.equal(view.find({ label: 'Transcription API key' })!.props.placeholder, 'OpenRouter key sk-or-…')
  await view.select({ label: 'Transcription provider' }, 'openai')
  assert.equal(view.find({ label: 'Transcription model' })!.props.placeholder, 'gpt-transcribe')
  assert.equal(view.find({ label: 'Transcription API key' })!.props.placeholder, 'OpenAI key sk-…')
  assert.ok(view.find({ text: /sent to OpenAI to be transcribed/ }))
  await view.unmount()
})

test('the key placeholder says saved when a voice key is stored', async () => {
  const state = makeState({
    bridges: [makeBridge('b1', { config: { voiceEnabled: true, hasVoiceKey: true } })]
  })
  const view = await mount(panel, { host: savingHost(state, []) })
  await openEditor(view, 'b1')
  assert.equal(view.find({ label: 'Transcription API key' })!.props.placeholder, '•••• (saved)')
  assert.equal(view.find({ text: /Add an API key/ }), null)
  await view.unmount()
})

test('the bridge card shows the voice provider and the no-key hint', async () => {
  const state = makeState({
    bridges: [
      makeBridge('a', { name: 'A' }),
      makeBridge('b', {
        name: 'B',
        config: { orcaBot: 'CIWatcher', voiceEnabled: true, voiceProvider: 'openai', voiceModel: 'whisper-1', hasVoiceKey: true }
      }),
      makeBridge('c', { name: 'C', config: { orcaBot: 'DevHelper', voiceEnabled: true } })
    ]
  })
  const view = await mount(panel, { host: savingHost(state, []) })
  assert.ok(view.find({ text: 'Voice: off' }))
  await selectInSidebar(view, botFocus('CIWatcher'))
  assert.ok(view.find({ text: 'Voice: OpenAI' }))
  await selectInSidebar(view, botFocus('DevHelper'))
  assert.ok(view.find({ text: 'Voice: OpenRouter – no API key' }))
  await view.unmount()
})

test('failing worker request shows feedback and refresh keeps unsaved edits', async () => {
  let failSetEnabled = true
  const host = panelHost({
    requests: {
      'bridge.getState': () => makeState(),
      'bridge.setEnabled': () => {
        if (failSetEnabled) throw new Error('worker exploded')
        return makeState()
      }
    }
  })
  const view = await mount(panel, { host })
  await openEditor(view, 'b1')
  await openAdvanced(view)
  await view.type({ label: 'HTTP proxy URL' }, 'http://10.0.0.1:8080', { replace: true })

  await view.toggle({ label: 'Active' })
  assert.ok(view.find({ text: /worker exploded/ }))
  // the switch shows the worker's state, so a failed request leaves it on
  assert.equal(view.valueOf({ label: 'Active' }), true)
  // busy must be released so controls stay usable after the failure
  assert.equal(view.find({ label: 'Active' })!.props.disabled, false)
  failSetEnabled = false
  await view.press({ text: 'Refresh' })
  assert.equal(view.valueOf({ label: 'HTTP proxy URL' }), 'http://10.0.0.1:8080')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('turning Active off asks the worker at once and shows the paused state', async () => {
  let current = makeState()
  const sent: Array<{ bridgeId: string; enabled: boolean }> = []
  const host = panelHost({
    requests: {
      'bridge.getState': () => current,
      'bridge.setEnabled': (input: { bridgeId: string; enabled: boolean }) => {
        sent.push(input)
        current = withBridge(current, input.bridgeId, {
          status: input.enabled ? 'connected' : 'stopped',
          polling: input.enabled,
          config: { enabled: input.enabled }
        })
        return current
      }
    }
  })
  const view = await mount(panel, { host })
  assert.equal(view.valueOf({ label: 'Active' }), true)
  assert.ok(view.find({ text: 'Connected' }))

  await view.toggle({ label: 'Active' })
  assert.deepEqual(sent, [{ bridgeId: 'b1', enabled: false }])
  assert.equal(view.valueOf({ label: 'Active' }), false)
  assert.ok(view.find({ text: 'Paused' }))
  assert.equal(view.find({ text: 'Connected' }), null)
  // the old header toggle must not come back as 'Start Polling' once paused
  assert.equal(view.find({ text: 'Start Polling' }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('bot on/off has one control per bridge: no polling button and no switch in the editor', async () => {
  const host = panelHost({
    requests: { 'bridge.getState': () => makeState({ bridges: twoBridges() }) }
  })
  const view = await mount(panel, { host })
  await openEditor(view, 'dev')
  assert.equal(view.find({ text: 'Pause Polling' }), null)
  assert.equal(view.find({ text: 'Start Polling' }), null)
  assert.equal(view.find({ label: 'Enable automatic polling' }), null)
  assert.equal(view.findAll({ label: 'Active' }).length, 1)
  await view.unmount()
})

test('without a saved token the Active switch is disabled and says why', async () => {
  const state = makeState({
    bridges: [
      makeBridge('b1', {
        status: 'needs_token',
        polling: false,
        botUsername: null,
        config: { hasToken: false }
      })
    ]
  })
  const host = panelHost({ requests: { 'bridge.getState': () => state } })
  const view = await mount(panel, { host })
  assert.equal(view.find({ label: 'Active' })!.props.disabled, true)
  assert.ok(view.find({ text: 'Save a bot token first.' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('long log messages are truncated below the label limit', async () => {
  const long = 'x'.repeat(5000)
  const host = panelHost({
    requests: {
      'bridge.getState': () =>
        makeState({ logs: [{ id: '1', at: Date.now(), level: 'error', bridgeId: 'b1', message: long }] })
    }
  })
  const view = await mount(panel, { host })
  await view.select(TABS, 'logs')
  const item = view.find({ label: /^x+…$/ })
  assert.ok(item)
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('log level filter hides entries outside the chosen level', async () => {
  const at = Date.now()
  const host = panelHost({
    requests: {
      'bridge.getState': () =>
        makeState({
          logTotal: 4,
          logs: [
            { id: 'e', at, level: 'error', scope: 'orca-cli', bridgeId: 'b1', message: 'Orca CLI call failed' },
            { id: 'w', at, level: 'warn', scope: 'telegram', bridgeId: 'b1', message: 'Telegram answered slowly' },
            { id: 'i', at, level: 'info', scope: 'bridge', bridgeId: 'b1', message: 'Polling started' },
            { id: 'd', at, level: 'debug', scope: 'dispatch', bridgeId: 'b1', message: 'Dispatch finished in 12 ms' }
          ]
        })
    }
  })
  const view = await mount(panel, { host })
  await view.select(TABS, 'logs')
  assert.ok(view.find({ label: 'Polling started' }))
  assert.ok(view.find({ text: 'Showing 4 of 4 entries' }))

  await view.select({ label: 'Log level filter' }, 'errors')
  assert.ok(view.find({ label: 'Orca CLI call failed' }))
  assert.equal(view.find({ label: 'Telegram answered slowly' }), null)
  assert.equal(view.find({ label: 'Polling started' }), null)
  assert.equal(view.find({ label: 'Dispatch finished in 12 ms' }), null)
  assert.ok(view.find({ text: 'Showing 1 of 4 entries' }))

  await view.select({ label: 'Log level filter' }, 'warnings')
  assert.ok(view.find({ label: 'Orca CLI call failed' }))
  assert.ok(view.find({ label: 'Telegram answered slowly' }))
  assert.equal(view.find({ label: 'Polling started' }), null)

  await view.select({ label: 'Log level filter' }, 'debug')
  assert.ok(view.find({ label: 'Dispatch finished in 12 ms' }))
  assert.equal(view.find({ label: 'Orca CLI call failed' }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('an entry with details shows them after expanding, between plain entries', async () => {
  const at = Date.now()
  const details = 'OrcaCliError: orca exited with code 2\nargs: bot send --json\nexitCode: 2\nstderr: unknown bot'
  const host = panelHost({
    requests: {
      'bridge.getState': () =>
        makeState({
          logTotal: 3,
          logs: [
            { id: 'a', at, level: 'info', scope: 'dispatch', bridgeId: 'b1', message: 'Reply sent' },
            { id: 'b', at, level: 'error', scope: 'orca-cli', bridgeId: 'b1', message: 'Orca CLI call failed', details },
            { id: 'c', at, level: 'info', scope: 'bridge', bridgeId: 'b1', message: 'Polling started' }
          ]
        })
    }
  })
  const view = await mount(panel, { host })
  await view.select(TABS, 'logs')
  assert.ok(view.find({ label: 'Reply sent' }))
  assert.ok(view.find({ label: 'Polling started' }))
  assert.equal(view.find({ type: 'CodeView' }), null)

  const entry = view.find({ type: 'Collapsible', label: 'Orca CLI call failed' })
  assert.ok(entry)
  assert.match(String(entry!.props.description), /^ERROR · orca-cli · /)
  await view.toggle(entry!)
  const code = view.find({ type: 'CodeView' })
  assert.ok(code)
  assert.equal(code!.props.code, details)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('export logs saves the worker text as a file and reports only a real save', async () => {
  const exported = { fileName: 'telegram-bridge-logs-2026-11-25.txt', text: 'Telegram Bridge 0.2.0\n\n[error] boom' }
  let exportCalls = 0
  const host = panelHost({
    results: { 'files.saveAs': { status: 'cancelled' } },
    requests: {
      'bridge.getState': () => makeState(),
      'bridge.exportLogs': () => {
        exportCalls += 1
        return exported
      }
    }
  })
  const view = await mount(panel, { host })
  await view.select(TABS, 'logs')

  await view.press({ text: 'Export logs' })
  assert.equal(exportCalls, 1)
  assert.deepEqual(
    host.calls.filter((c) => c.method === 'files.saveAs').map((c) => c.params),
    [{ suggestedName: exported.fileName, mimeType: 'text/plain', data: exported.text }]
  )
  assert.equal(view.find({ text: 'Logs exported.' }), null)

  host.respond('files.saveAs', { status: 'saved' })
  await view.press({ text: 'Export logs' })
  assert.equal(exportCalls, 2)
  assert.ok(view.find({ text: 'Logs exported.' }))
  assert.deepEqual(view.refusals, [])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('debug logging switch asks the worker to turn global debug logging on', async () => {
  let current = makeState()
  const sent: Array<{ enabled: boolean }> = []
  const host = panelHost({
    requests: {
      'bridge.getState': () => current,
      'bridge.setDebugLogging': (input: { enabled: boolean }) => {
        sent.push(input)
        current = makeState({ global: { debugLogging: input.enabled } })
        return current
      }
    }
  })
  const view = await mount(panel, { host })
  await view.select(TABS, 'logs')
  assert.equal(view.valueOf({ label: 'Debug logging' }), false)

  await view.toggle({ label: 'Debug logging' })
  assert.deepEqual(sent, [{ enabled: true }])
  assert.equal(view.valueOf({ label: 'Debug logging' }), true)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

// Entries stored before 0.5.0 name no bridge, so only the every-bridge view shows them.
test('entries stored by 0.2.0 without scope render as bridge entries', async () => {
  const host = panelHost(
    {
      requests: {
        'bridge.getState': () =>
          makeState({
            logs: [{ id: 'old', at: Date.now(), level: 'warn', message: 'Telegram polling paused.' }]
          })
      }
    },
    { kind: 'unknown', reason: 'test' }
  )
  const view = await mount(panel, { host })
  await view.select(TABS, 'logs')
  const item = view.find({ label: 'Telegram polling paused.' })
  assert.ok(item)
  assert.equal(item!.props.description, 'WARN · bridge')
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

async function mountWithAllowed(allowedUserIds: string, syncOrcaOutbound = false) {
  const state = makeState({
    bridges: [makeBridge('b1', { config: { allowedUserIds, syncOrcaOutbound } })]
  })
  const host = panelHost({ requests: { 'bridge.getState': () => state } })
  const view = await mount(panel, { host })
  await view.select(TABS, 'setup')
  await openEditor(view, 'b1')
  return view
}

// A Callout's title is a prop, not part of the text the finders match.
function calloutsTitled(view: TestPanel, title: string) {
  return view.findAll({ type: 'Callout' }).filter((c) => c.props.title === title)
}

function openWarnings(view: TestPanel) {
  return calloutsTitled(view, 'Open to everyone')
}

test('an empty allowlist shows the open to everyone warning naming the bot', async () => {
  const view = await mountWithAllowed('')
  assert.equal(openWarnings(view).length, 1)
  assert.ok(view.find({ text: /Anyone who finds @demo_orca_bot on Telegram can chat with Assistant/ }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a list with only a negative group ID hides the open warning', async () => {
  const view = await mountWithAllowed('-1001234567890')
  assert.equal(openWarnings(view).length, 0)
  await view.unmount()
})

test('an allowlist with no valid ID still counts as open', async () => {
  const view = await mountWithAllowed('abc, ,')
  assert.equal(openWarnings(view).length, 1)
  await view.unmount()
})

test('the open warning is per bridge: only the open bridge shows it', async () => {
  const host = panelHost(
    { requests: { 'bridge.getState': () => makeState({ bridges: twoBridges() }) } },
    botFocus('CIWatcher')
  )
  const view = await mount(panel, { host })
  assert.equal(openWarnings(view).length, 0)
  assert.equal(view.find({ text: /Anyone who finds @ci_bot/ }), null)
  await selectInSidebar(view, botFocus('Assistant'))
  assert.equal(openWarnings(view).length, 1)
  assert.ok(view.find({ text: /Anyone who finds @dev_bot on Telegram/ }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('sync on with an open allowlist says sync is paused, restricted list does not', async () => {
  const paused = /Sync is paused while the bot is open to everyone/
  const open = await mountWithAllowed('', true)
  assert.ok(open.find({ text: paused }))
  await open.unmount()

  const restricted = await mountWithAllowed('123456', true)
  assert.equal(restricted.find({ text: paused }), null)
  await restricted.unmount()

  const syncOff = await mountWithAllowed('', false)
  assert.equal(syncOff.find({ text: paused }), null)
  await syncOff.unmount()
})

function savedInputs(state: BridgeState, saved: SaveConfigInput[]) {
  return panelHost({
    requests: {
      'bridge.getState': () => state,
      'bridge.saveConfig': (input: SaveConfigInput) => {
        saved.push(input)
        return state
      }
    }
  })
}

const NOBODY_YET = /Nobody can talk yet/

test('Anyone on Telegram saves an empty allowlist and keeps the rows as roles', async () => {
  const saved: SaveConfigInput[] = []
  const view = await mount(panel, { host: savedInputs(makeState(), saved) })
  await openEditor(view, 'b1')
  assert.equal(view.valueOf({ label: 'Who can talk' }), 'restricted')
  assert.equal(view.valueOf({ label: 'Telegram ID 1' }), '123456')
  // listed without a role: Member, as the worker reads it
  assert.equal(view.valueOf({ label: 'Role for Telegram ID 1' }), 'member')

  await view.select({ label: 'Who can talk' }, 'open')
  assert.equal(calloutsTitled(view, 'Anyone can use this bot').length, 1)
  assert.ok(view.find({ text: /Anyone who finds this bot can chat with Assistant/ }))
  assert.ok(view.find({ text: 'People with roles (everyone else is a Stranger)' }))
  // the rows stay: while open they only give roles
  assert.equal(view.valueOf({ label: 'Telegram ID 1' }), '123456')
  await view.select({ label: 'Who can talk' }, 'restricted')
  assert.equal(view.valueOf({ label: 'Telegram ID 1' }), '123456')
  assert.equal(calloutsTitled(view, 'Anyone can use this bot').length, 0)

  await view.select({ label: 'Who can talk' }, 'open')
  await view.press({ text: 'Save' })
  assert.equal(saved.length, 1)
  assert.equal(saved[0].allowedUserIds, '')
  assert.deepEqual(saved[0].roleAssignments, { '123456': 'member' })
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('open with no rows saves no roles for anyone; rows are optional', async () => {
  const saved: SaveConfigInput[] = []
  const view = await mount(panel, { host: savedInputs(makeState({ bridges: twoBridges() }), saved) })
  await openEditor(view, 'dev')
  assert.equal(view.valueOf({ label: 'Who can talk' }), 'open')
  assert.equal(view.find({ label: 'Telegram ID 1' }), null)
  await view.press({ text: 'Save' })
  assert.equal(saved.length, 1)
  assert.equal(saved[0].allowedUserIds, '')
  assert.equal(Object.keys(saved[0].roleAssignments ?? { x: 1 }).length, 0)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('Only these people and groups saves with no ID: nobody talks until someone is allowed', async () => {
  const saved: SaveConfigInput[] = []
  const view = await mount(panel, { host: savedInputs(makeState({ bridges: twoBridges() }), saved) })
  await openEditor(view, 'dev')
  assert.equal(view.valueOf({ label: 'Who can talk' }), 'open')
  assert.equal(view.find({ text: NOBODY_YET }), null)

  // choosing a list gives one empty row; the first row is Full access so the owner keeps access
  await view.select({ label: 'Who can talk' }, 'restricted')
  assert.equal(view.valueOf({ label: 'Telegram ID 1' }), '')
  assert.equal(view.valueOf({ label: 'Role for Telegram ID 1' }), 'full')
  assert.ok(view.find({ text: NOBODY_YET }))
  // the empty row is skipped: the bridge is saved restricted with an empty list
  await view.press({ text: 'Save' })
  assert.equal(saved.length, 1)
  assert.equal(saved[0].restricted, true)
  assert.equal(saved[0].allowedUserIds, '')
  assert.deepEqual(saved[0].roleAssignments, {})

  // Save closes the editor and the stored state is still open here: open it and choose the list again
  await openEditor(view, 'dev')
  await view.select({ label: 'Who can talk' }, 'restricted')
  // a row that is not an ID still refuses the save
  await view.type({ label: 'Telegram ID 1' }, 'abc')
  assert.equal(view.find({ text: NOBODY_YET }), null)
  await view.press({ text: 'Save' })
  assert.equal(saved.length, 1)
  assert.ok(view.find({ text: /"abc" is not a Telegram ID/ }))
  assert.equal(view.find({ label: 'Telegram ID 1' })!.props.invalid, true)

  await view.press({ label: 'Remove Telegram ID 1' })
  await view.press({ text: 'Add person or group' })
  await view.type({ label: 'Telegram ID 1' }, '42')
  await view.press({ text: 'Save' })
  assert.equal(saved.length, 2)
  assert.equal(saved[1].restricted, true)
  assert.equal(saved[1].allowedUserIds, '42')
  assert.deepEqual(saved[1].roleAssignments, { '42': 'full' })
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a restricted bridge with an empty list says nobody can talk yet on its card', async () => {
  const state = makeState({ bridges: [makeBridge('b1', { config: { restricted: true, allowedUserIds: '' } })] })
  const view = await mount(panel, { host: panelHost({ requests: { 'bridge.getState': () => state } }) })
  assert.ok(view.find({ text: 'People: none yet' }))
  assert.equal(view.find({ text: /Open to everyone/ }), null)
  await openEditor(view, 'b1')
  assert.equal(view.valueOf({ label: 'Who can talk' }), 'restricted')
  assert.ok(view.find({ text: NOBODY_YET }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('rows: added rows get Member, each role select is saved, removed rows are gone', async () => {
  const saved: SaveConfigInput[] = []
  const view = await mount(panel, { host: savedInputs(makeState(), saved) })
  await openEditor(view, 'b1')
  await view.press({ text: 'Add person or group' })
  assert.equal(view.valueOf({ label: 'Role for Telegram ID 2' }), 'member')
  await view.type({ label: 'Telegram ID 2' }, '-1001234567890')
  await view.press({ text: 'Add person or group' })
  await view.type({ label: 'Telegram ID 3' }, '777')
  await view.select({ label: 'Role for Telegram ID 1' }, 'full')
  await view.select({ label: 'Role for Telegram ID 3' }, 'stranger')

  // the role select offers every role of this bridge
  const options = view.find({ label: 'Role for Telegram ID 1' })!.props.options as { value: string }[]
  assert.deepEqual(options.map((o) => o.value), ['full', 'member', 'stranger'])

  await view.press({ label: 'Remove Telegram ID 3' })
  assert.equal(view.find({ label: 'Telegram ID 3' }), null)
  // an empty row is skipped, not refused
  await view.press({ text: 'Add person or group' })
  await view.press({ text: 'Save' })
  assert.equal(saved.length, 1)
  assert.equal(saved[0].allowedUserIds, '123456, -1001234567890')
  assert.deepEqual(saved[0].roleAssignments, { '123456': 'full', '-1001234567890': 'member' })
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a saved ID shows "ID @name" read-only and saves the bare ID; a new row stays editable', async () => {
  const saved: SaveConfigInput[] = []
  const state = makeState({
    bridges: [makeBridge('b1', { knownNames: { '123456': '@ana_dev', '-1001234567890': 'Ops Team' } })]
  })
  const view = await mount(panel, { host: savedInputs(state, saved) })
  await openEditor(view, 'b1')
  // one "@": the name already carries it
  assert.equal(view.valueOf({ label: 'Telegram ID 1' }), '123456 @ana_dev')
  // typing into a saved ID changes nothing (the kit may refuse a field without onChange)
  await view.type({ label: 'Telegram ID 1' }, '777', { replace: true }).catch(() => undefined)
  assert.equal(view.valueOf({ label: 'Telegram ID 1' }), '123456 @ana_dev')

  // a row added in the editor takes typing, without a name, even for an ID the bridge knows
  await view.press({ text: 'Add person or group' })
  await view.type({ label: 'Telegram ID 2' }, '-1001234567890')
  assert.equal(view.valueOf({ label: 'Telegram ID 2' }), '-1001234567890')

  await view.press({ text: 'Save' })
  assert.equal(saved.length, 1)
  assert.equal(saved[0].allowedUserIds, '123456, -1001234567890')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('the editor has sections and keeps the rare options in a closed Advanced', async () => {
  const view = await mountWithAllowed('123456')
  const headings = view
    .findAll({ type: 'Heading' })
    .filter((h) => h.props.level === 3)
    .map((h) => h.text)
  assert.deepEqual(headings, ['Connection', 'Who can talk', 'Groups', 'Features'])

  assert.ok(view.find({ type: 'Collapsible', label: 'Advanced' }))
  assert.equal(view.find({ label: 'Telegram reply language' }), null)
  assert.equal(view.find({ label: 'Reply timeout (seconds)' }), null)
  assert.equal(view.find({ label: 'HTTP proxy URL' }), null)

  await openAdvanced(view)
  assert.ok(view.find({ label: 'Telegram reply language' }))
  assert.equal(view.valueOf({ label: 'Reply timeout (seconds)' }), '300')
  assert.equal(view.find({ label: 'HTTP proxy URL' })!.props.placeholder, undefined)
  assert.ok(view.find({ text: 'Leave empty unless you need a proxy.' }))
  // the transcription model shows only while voice is on
  assert.equal(view.find({ label: 'Transcription model' }), null)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

const ALL_NOTE = /Following the conversation works only with "Only these people and groups"/
const PRIVACY_TITLE = 'Privacy mode is on'
const JOIN_TITLE = 'This bot cannot join groups'

async function mountGroups(
  config: Partial<BridgeConfig>,
  telegramCaps: BridgeView['telegramCaps'] = { canJoinGroups: true, canReadAllGroupMessages: true }
) {
  const state = makeState({ bridges: [makeBridge('b1', { telegramCaps, config })] })
  const host = panelHost({ requests: { 'bridge.getState': () => state } })
  const view = await mount(panel, { host })
  await openEditor(view, 'b1')
  return view
}

test('one group choice says what the bot reads and when it answers, and Save maps it to the three fields', async () => {
  const state = makeState()
  const saved: SaveConfigInput[] = []
  const host = panelHost({
    requests: {
      'bridge.getState': () => state,
      'bridge.saveConfig': (input: SaveConfigInput) => {
        saved.push(input)
        // Answer like the worker: the state after the save, so the editor keeps the saved values.
        const bridge = state.bridges.find((b) => b.id === input.bridgeId)!
        bridge.config = {
          ...bridge.config,
          allowGroups: input.allowGroups!,
          groupMode: input.groupMode!,
          groupReply: input.groupReply!
        }
        return state
      }
    }
  })
  const view = await mount(panel, { host })
  await openEditor(view, 'b1')
  const groups = { label: 'In groups' }
  assert.equal(view.valueOf(groups), 'off')
  // Every option but Off says what the bot reads and when it answers.
  const options = view.find(groups)!.props.options as { value: string; description: string }[]
  for (const option of options.filter((o) => o.value !== 'off')) {
    assert.match(option.description, /^Reads .*[Aa]nswers/, option.value)
  }
  assert.equal(view.find({ text: /one bot turn per message/ }), null)

  await view.select(groups, 'addressed')
  assert.equal(view.find({ text: /one bot turn per message/ }), null)

  await view.select(groups, 'all-helpful')
  assert.ok(view.find({ text: /Following the conversation sends every group message to the Orca bot: one bot turn per message\./ }))
  await view.press({ text: 'Save' })
  assert.equal(saved[0].allowGroups, true)
  assert.equal(saved[0].groupMode, 'all')
  assert.equal(saved[0].groupReply, 'helpful')
  // Reopened, the editor shows what was saved.
  await openEditor(view, 'b1')
  assert.equal(view.valueOf(groups), 'all-helpful')

  await view.select(groups, 'off')
  assert.equal(view.find({ text: /one bot turn per message/ }), null)
  await view.press({ text: 'Save' })
  assert.equal(saved[1].allowGroups, false)
  // Off keeps the mode and reply policy for the next time groups are turned on
  assert.equal(saved[1].groupMode, 'all')
  assert.equal(saved[1].groupReply, 'helpful')

  await openEditor(view, 'b1')
  await view.select(groups, 'all-mentioned')
  await view.press({ text: 'Save' })
  assert.deepEqual([saved[2].allowGroups, saved[2].groupMode, saved[2].groupReply], [true, 'all', 'mentioned'])

  await openEditor(view, 'b1')
  await view.select(groups, 'all-learn')
  assert.ok(view.find({ text: /one bot turn per message/ }))
  await view.press({ text: 'Save' })
  assert.deepEqual([saved[3].allowGroups, saved[3].groupMode, saved[3].groupReply], [true, 'all', 'learn'])
  await openEditor(view, 'b1')
  assert.equal(view.valueOf(groups), 'all-learn')
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('each bridge card says how it reads groups', async () => {
  // One bridge per Orca bot, so each bot's view shows one of the group setups.
  const setups: Array<{ bot: string; config: Partial<BridgeConfig>; summary: string }> = [
    { bot: 'Off', config: {}, summary: 'Groups: off' },
    { bot: 'Addressed', config: { allowGroups: true }, summary: 'Groups: answers when called' },
    {
      bot: 'All',
      config: { allowGroups: true, groupMode: 'all' },
      summary: 'Groups: follows the conversation, answers when called'
    },
    {
      bot: 'Help',
      config: { allowGroups: true, groupMode: 'all', groupReply: 'helpful' },
      summary: 'Groups: follows the conversation, joins in when useful'
    },
    {
      bot: 'Open',
      config: { allowGroups: true, groupMode: 'all', allowedUserIds: '' },
      summary: 'Groups: answers when called (following the conversation needs an ID list)'
    },
    {
      bot: 'Learn',
      config: { allowGroups: true, groupMode: 'all', groupReply: 'learn' },
      summary: 'Groups: learns from the conversation, never answers'
    },
    {
      bot: 'OpenLearn',
      config: { allowGroups: true, groupMode: 'all', groupReply: 'learn', allowedUserIds: '' },
      summary: 'Groups: reads nothing (learning needs an ID list)'
    }
  ]
  const state = makeState({
    bridges: setups.map((s) => makeBridge(s.bot.toLowerCase(), { name: s.bot, config: { ...s.config, orcaBot: s.bot } })),
    bots: setups.map((s) => ({ id: `bot-${s.bot}`, name: s.bot, specialty: '', agent: 'claude' }))
  })
  const host = panelHost({ requests: { 'bridge.getState': () => state } }, botFocus('Off'))
  const view = await mount(panel, { host })
  for (const setup of setups) {
    await selectInSidebar(view, botFocus(setup.bot))
    assert.ok(view.find({ text: setup.summary }), setup.bot)
  }
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('following the conversation with an open list says it reads only messages for the bot', async () => {
  const open = await mountGroups({ allowGroups: true, groupMode: 'all', allowedUserIds: '' })
  assert.ok(open.find({ text: ALL_NOTE }))
  await open.unmount()

  const restricted = await mountGroups({ allowGroups: true, groupMode: 'all', allowedUserIds: '42' })
  assert.equal(restricted.find({ text: ALL_NOTE }), null)
  await restricted.unmount()
})

test('privacy mode on shows the BotFather steps', async () => {
  const view = await mountGroups(
    { allowGroups: true },
    { canJoinGroups: true, canReadAllGroupMessages: false }
  )
  assert.equal(calloutsTitled(view, PRIVACY_TITLE).length, 1)
  assert.ok(view.find({ text: '1. In @BotFather, send /setprivacy and pick this bot.' }))
  assert.ok(view.find({ text: '2. Choose Disable.' }))
  assert.ok(view.find({ text: '3. Add the bot to the group again.' }))
  assert.equal(calloutsTitled(view, JOIN_TITLE).length, 0)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a bot Telegram keeps out of groups shows the join warning', async () => {
  const view = await mountGroups(
    { allowGroups: true },
    { canJoinGroups: false, canReadAllGroupMessages: true }
  )
  assert.equal(calloutsTitled(view, JOIN_TITLE).length, 1)
  assert.ok(view.find({ text: /send \/setjoingroups/ }))
  assert.equal(calloutsTitled(view, PRIVACY_TITLE).length, 0)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('no BotFather notes without Telegram caps or with groups off', async () => {
  const unknown = await mountGroups({ allowGroups: true }, null)
  assert.equal(calloutsTitled(unknown, JOIN_TITLE).length, 0)
  assert.equal(calloutsTitled(unknown, PRIVACY_TITLE).length, 0)
  await unknown.unmount()

  const groupsOff = await mountGroups(
    { allowGroups: false },
    { canJoinGroups: false, canReadAllGroupMessages: false }
  )
  assert.equal(calloutsTitled(groupsOff, JOIN_TITLE).length, 0)
  assert.equal(calloutsTitled(groupsOff, PRIVACY_TITLE).length, 0)
  await groupsOff.unmount()
})

const PROMPT_HELPER = 'A hint to the bot, not a lock: only the checkboxes above are enforced. People never see it.'
const REVIEW_TEXT = 'After the update everyone on the list kept full access. Review their roles.'
const AUTOMATIONS = [
  { id: 'a1', name: 'Nightly build' },
  { id: 'a2', name: 'Backup' }
]

function customRole(id: string, name: string): BridgeRole {
  return { id, name, permissions: ['chat', 'sync'], prompt: '', runAutomationIds: null }
}

// A worker stand-in for the roles tests: saves like the worker (roles given -> reviewed) and
// answers the automations list, counting the requests.
function rolesHost(
  initial: BridgeState,
  saved: SaveConfigInput[],
  listAutomations: () => { id: string; name: string }[] = () => AUTOMATIONS
) {
  let state = initial
  const counts = { listAutomations: 0 }
  const host = panelHost({
    requests: {
      'bridge.getState': () => state,
      'bridge.listAutomations': () => {
        counts.listAutomations += 1
        return listAutomations()
      },
      'bridge.saveConfig': (input: SaveConfigInput) => {
        saved.push(input)
        const bridge = state.bridges.find((b) => b.id === input.bridgeId)!
        state = withBridge(state, input.bridgeId, {
          config: {
            restricted: input.restricted ?? bridge.config.restricted,
            allowedUserIds: input.allowedUserIds,
            roles: input.roles ?? bridge.config.roles,
            roleAssignments: input.roleAssignments ?? bridge.config.roleAssignments,
            rolesReviewed: bridge.config.rolesReviewed || input.roles !== undefined || input.roleAssignments !== undefined
          }
        })
        return state
      }
    }
  })
  return { host, counts }
}

async function openRoles(view: TestPanel): Promise<void> {
  await view.toggle({ type: 'Collapsible', label: 'Roles' })
}

function savedRole(input: SaveConfigInput, roleId: string): BridgeRole {
  const role = input.roles?.find((r) => r.id === roleId)
  assert.ok(role, `role ${roleId} was saved`)
  return role
}

test('roles: a ticked permission and the prompt are saved; Full and Stranger lock their boxes', async () => {
  const saved: SaveConfigInput[] = []
  const view = await mount(panel, { host: rolesHost(makeState(), saved).host })
  await openEditor(view, 'b1')
  // Roles starts closed
  assert.equal(view.find({ type: 'Collapsible', label: 'Member' }), null)
  await openRoles(view)
  const member = view.find({ type: 'Collapsible', label: 'Member' })
  assert.ok(member)
  assert.equal(member.props.description, 'can: chat, /status, /new in private')

  await view.toggle({ type: 'Collapsible', label: 'Member' })
  assert.equal(view.find({ testId: 'perm:member:sync' })!.label, '/sync')
  assert.equal(view.valueOf({ testId: 'perm:member:sync' }), false)
  await view.toggle({ testId: 'perm:member:sync' })
  assert.equal(view.valueOf({ testId: 'perm:member:sync' }), true)
  // built-in roles keep their names
  assert.equal(view.find({ testId: 'role-name:member' })!.disabled, true)
  assert.equal(view.find({ testId: 'delete-role:member' }), null)
  await view.type({ testId: 'prompt:member' }, 'Answer in short sentences.')
  assert.ok(view.find({ text: PROMPT_HELPER }))

  await view.toggle({ type: 'Collapsible', label: 'Stranger' })
  for (const p of ['bots', 'newGroup', 'homePrivate', 'homeGroup', 'bindPrivate', 'bindGroup', 'rename', 'sync', 'automations', 'run', 'errorDetails']) {
    const box = view.find({ testId: `perm:stranger:${p}` })
    assert.ok(box, p)
    assert.equal(box.disabled, true, p)
    assert.equal(box.props.checked, false, p)
  }
  assert.equal(view.find({ testId: 'perm:stranger:chat' })!.disabled, false)
  assert.equal(view.find({ testId: 'perm:stranger:status' })!.disabled, false)

  // Full access always has everything
  await view.toggle({ type: 'Collapsible', label: 'Full access' })
  assert.equal(view.find({ testId: 'perm:full:sync' })!.disabled, true)
  assert.equal(view.find({ testId: 'perm:full:sync' })!.props.checked, true)

  await view.press({ text: 'Save' })
  assert.equal(saved.length, 1)
  const role = savedRole(saved[0], 'member')
  assert.deepEqual(role.permissions, ['chat', 'status', 'newPrivate', 'sync'])
  assert.equal(role.prompt, 'Answer in short sentences.')
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('roles: with /run, Only these saves the ticked automations from Orca', async () => {
  const saved: SaveConfigInput[] = []
  const { host, counts } = rolesHost(makeState(), saved)
  const view = await mount(panel, { host })
  await openEditor(view, 'b1')
  assert.equal(counts.listAutomations, 0)
  // opening Roles loads the automations
  await openRoles(view)
  assert.equal(counts.listAutomations, 1)
  await view.toggle({ type: 'Collapsible', label: 'Member' })
  // the picker shows only with /run ticked
  assert.equal(view.find({ testId: 'run-scope:member' }), null)
  await view.toggle({ testId: 'perm:member:run' })
  assert.equal(view.valueOf({ testId: 'run-scope:member' }), 'all')
  assert.equal(view.find({ label: 'Backup' }), null)

  await view.select({ testId: 'run-scope:member' }, 'only')
  assert.ok(view.find({ label: 'Nightly build' }))
  await view.toggle({ label: 'Backup' })
  assert.equal(view.valueOf({ label: 'Backup' }), true)
  await view.press({ text: 'Save' })
  const role = savedRole(saved[0], 'member')
  assert.ok(role.permissions.includes('run'))
  assert.deepEqual(role.runAutomationIds, ['a2'])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('roles: when Orca cannot list automations, Only these shows a muted note', async () => {
  const saved: SaveConfigInput[] = []
  const { host } = rolesHost(makeState(), saved, () => {
    throw new Error('orca exited with code 1')
  })
  const view = await mount(panel, { host })
  await openEditor(view, 'b1')
  await openRoles(view)
  await view.toggle({ type: 'Collapsible', label: 'Member' })
  await view.toggle({ testId: 'perm:member:run' })
  await view.select({ testId: 'run-scope:member' }, 'only')
  const note = view.find({ text: /Could not load Orca's automations/ })
  assert.ok(note)
  assert.equal(note.props.muted, true)
  // the role still saves, with an empty list (runs none)
  await view.press({ text: 'Save' })
  assert.deepEqual(savedRole(saved[0], 'member').runAutomationIds, [])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('roles: Add role makes a custom role rows can pick', async () => {
  const saved: SaveConfigInput[] = []
  const view = await mount(panel, { host: rolesHost(makeState(), saved).host })
  await openEditor(view, 'b1')
  await openRoles(view)
  await view.press({ text: 'Add role' })
  assert.ok(view.find({ type: 'Collapsible', label: 'New role' }))
  const options = view.find({ label: 'Role for Telegram ID 1' })!.props.options as { value: string; label: string }[]
  const added = options.find((o) => o.label === 'New role')
  assert.ok(added)
  assert.match(added.value, /^r-[a-z0-9]+$/)
  await view.select({ label: 'Role for Telegram ID 1' }, added.value)
  await view.press({ text: 'Save' })
  assert.equal(savedRole(saved[0], added.value).name, 'New role')
  assert.deepEqual(saved[0].roleAssignments, { '123456': added.value })
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('roles: deleting a custom role moves its rows to Member, with a note', async () => {
  const saved: SaveConfigInput[] = []
  const state = makeState({
    bridges: [
      makeBridge('b1', {
        config: {
          allowedUserIds: '123456, 777',
          roles: [...defaultRoles(), customRole('r-team', 'Team')],
          roleAssignments: { '123456': 'r-team', '777': 'full' }
        }
      })
    ]
  })
  const view = await mount(panel, { host: rolesHost(state, saved).host })
  await openEditor(view, 'b1')
  assert.equal(view.valueOf({ label: 'Role for Telegram ID 1' }), 'r-team')
  await openRoles(view)
  await view.toggle({ type: 'Collapsible', label: 'Team' })
  assert.equal(view.find({ testId: 'role-name:r-team' })!.disabled, false)
  await view.press({ testId: 'delete-role:r-team' })
  assert.equal(view.find({ type: 'Collapsible', label: 'Team' }), null)
  assert.equal(view.valueOf({ label: 'Role for Telegram ID 1' }), 'member')
  assert.equal(view.valueOf({ label: 'Role for Telegram ID 2' }), 'full')
  assert.ok(view.find({ text: /1 person or group had a role that is gone and now have Member/ }))

  await view.press({ text: 'Save' })
  assert.deepEqual(
    saved[0].roles!.map((r) => r.id),
    ['full', 'member', 'stranger']
  )
  assert.deepEqual(saved[0].roleAssignments, { '123456': 'member', '777': 'full' })
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('roles: Copy takes another bridge’s roles into this editor, not its people', async () => {
  const saved: SaveConfigInput[] = []
  const bridges = twoBridges()
  bridges[0].config.roles = [...defaultRoles(), customRole('r-team', 'Team')]
  bridges[1].config.roles = [...defaultRoles(), customRole('r-old', 'Old')]
  bridges[1].config.roleAssignments = { '555': 'r-old' }
  const view = await mount(panel, { host: rolesHost(makeState({ bridges }), saved).host })
  // Assistant is selected: the open @dev_bot shows
  await openEditor(view, 'dev')
  assert.equal(view.valueOf({ label: 'Telegram ID 1' }), '555')
  await openRoles(view)
  assert.ok(view.find({ type: 'Collapsible', label: 'Old' }))
  const from = view.find({ label: 'Copy roles from' })!.props.options as { value: string; label: string }[]
  assert.deepEqual(from, [{ value: 'ci', label: '@ci_bot' }])

  await view.select({ label: 'Copy roles from' }, 'ci')
  await view.press({ text: 'Copy' })
  assert.ok(view.find({ type: 'Collapsible', label: 'Team' }))
  assert.equal(view.find({ type: 'Collapsible', label: 'Old' }), null)
  // the people stay; a role that is gone falls back to Member
  assert.equal(view.valueOf({ label: 'Telegram ID 1' }), '555')
  assert.equal(view.valueOf({ label: 'Role for Telegram ID 1' }), 'member')

  await view.press({ text: 'Save' })
  assert.deepEqual(
    saved[0].roles!.map((r) => r.id),
    ['full', 'member', 'stranger', 'r-team']
  )
  assert.deepEqual(saved[0].roleAssignments, { '555': 'member' })
  assert.equal(saved[0].allowedUserIds, '')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('the review banner shows on the card and in the editor until the roles are saved', async () => {
  const saved: SaveConfigInput[] = []
  const state = makeState({ bridges: [makeBridge('b1', { config: { rolesReviewed: false } })] })
  const view = await mount(panel, { host: rolesHost(state, saved).host })
  assert.equal(calloutsTitled(view, 'Review roles').length, 1)
  assert.ok(view.find({ text: REVIEW_TEXT }))
  await openEditor(view, 'b1')
  // the card stays above its open editor: one banner each
  assert.equal(calloutsTitled(view, 'Review roles').length, 2)
  await view.press({ text: 'Save' })
  assert.equal(saved.length, 1)
  assert.equal(calloutsTitled(view, 'Review roles').length, 0)
  assert.equal(view.find({ text: REVIEW_TEXT }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('no review banner once the roles were reviewed', async () => {
  const view = await mountWithAllowed('123456')
  assert.equal(calloutsTitled(view, 'Review roles').length, 0)
  await view.unmount()
})

test('each bridge card says who can talk and with which role', async () => {
  const restricted = makeState({
    bridges: [
      makeBridge('b1', {
        config: { allowedUserIds: '1, 2, 3', roleAssignments: { '1': 'full', '2': 'member' } }
      })
    ]
  })
  let view = await mount(panel, { host: panelHost({ requests: { 'bridge.getState': () => restricted } }) })
  // ID 3 has no role: Member
  assert.ok(view.find({ text: 'People: 3 (Full access 1, Member 2)' }))
  await view.unmount()

  const open = makeState({ bridges: [makeBridge('b1', { config: { allowedUserIds: '' } })] })
  view = await mount(panel, { host: panelHost({ requests: { 'bridge.getState': () => open } }) })
  assert.ok(view.find({ text: 'Anyone on Telegram (Stranger)' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

function auditEntry(id: string, patch: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id,
    at: Date.now(),
    bridgeId: 'ci',
    source: 'telegram',
    userId: '111',
    userLabel: '@joao',
    chatId: '-100123',
    roleName: 'Member',
    action: 'run',
    target: 'Daily backup',
    result: 'done',
    ...patch
  }
}

function auditHost(queries: AuditQuery[], entries: AuditEntry[], focus: FocusedBot, options: MockHostOptions = {}) {
  return panelHost(
    {
      ...options,
      requests: {
        'bridge.getState': () => makeState({ bridges: twoBridges() }),
        'bridge.listAudit': (input: AuditQuery) => {
          queries.push(input)
          return { entries, total: entries.length === 0 ? 0 : 7 }
        },
        ...options.requests
      }
    },
    focus
  )
}

test("the Audit tab asks for the selected bot's bridge with its filters and marks refusals", async () => {
  const queries: AuditQuery[] = []
  const entries = [auditEntry('a2', { action: 'refused', target: '/run', result: 'refused' }), auditEntry('a1')]
  const view = await mount(panel, { host: auditHost(queries, entries, botFocus('CIWatcher')) })
  // nothing is asked until the tab opens
  assert.equal(queries.length, 0)

  await view.select(TABS, 'audit')
  assert.equal(queries.length, 1)
  assert.deepEqual(queries[0], { bridgeId: 'ci' })
  assert.ok(view.find({ text: 'Showing 2 of 7' }))
  const done = view.find({ label: '@joao · Ran automation Daily backup' })
  assert.ok(done)
  assert.match(String(done!.props.description), / · Member · chat -100123$/)
  assert.ok(view.find({ label: '@joao · Refused /run' }))
  const badges = view.findAll({ type: 'Badge' })
  assert.equal(badges.length, 1)
  assert.equal(badges[0].text, 'Refused')
  assert.equal(badges[0].props.tone, 'danger')

  await view.select({ label: 'Action' }, 'run')
  assert.deepEqual(queries[queries.length - 1], { bridgeId: 'ci', action: 'run' })
  await view.select({ label: 'Result' }, 'refused')
  assert.deepEqual(queries[queries.length - 1], { bridgeId: 'ci', action: 'run', result: 'refused' })

  // Refresh asks again with the same filters
  const before = queries.length
  await view.press({ text: 'Refresh' })
  assert.ok(queries.length > before)
  assert.deepEqual(queries[queries.length - 1], { bridgeId: 'ci', action: 'run', result: 'refused' })

  // another bot: its own bridge (the one stored with '' follows the first Orca bot)
  await selectInSidebar(view, botFocus('Assistant'))
  assert.deepEqual(queries[queries.length - 1], { bridgeId: 'dev', action: 'run', result: 'refused' })
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('the Audit tab says when nothing is recorded, and asks nothing for a bot without a bridge', async () => {
  const queries: AuditQuery[] = []
  const view = await mount(panel, { host: auditHost(queries, [], botFocus('CIWatcher')) })
  await view.select(TABS, 'audit')
  assert.equal(queries.length, 1)
  assert.ok(view.find({ text: 'Nothing recorded yet.' }))
  assert.equal(view.find({ type: 'List', label: 'Audit entries' }), null)

  await selectInSidebar(view, botFocus('DevHelper'))
  assert.equal(queries.length, 1)
  assert.ok(view.find({ text: 'Nothing recorded yet.' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('when Orca cannot say which bot is selected the Audit tab asks for every bridge', async () => {
  const queries: AuditQuery[] = []
  const removed: AuditEntry = { id: 'a2', at: Date.now(), bridgeId: 'gone', source: 'panel', action: 'bridgeRemoved', result: 'done' }
  const entries = [auditEntry('a1'), removed]
  const view = await mount(panel, {
    host: auditHost(queries, entries, { kind: 'unknown', reason: 'This Orca does not name the focused workspace.' })
  })
  await view.select(TABS, 'audit')
  assert.equal(queries.length, 1)
  assert.equal(Object.keys(queries[0]).length, 0)
  // with every bridge shown, each entry names its bridge
  assert.match(String(view.find({ label: '@joao · Ran automation Daily backup' })!.props.description), / · @ci_bot$/)
  assert.match(String(view.find({ label: 'Orca panel · Removed bridge' })!.props.description), / · removed bridge$/)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('Export saves the worker CSV for the shown bridge and filters', async () => {
  const queries: AuditQuery[] = []
  const exportQueries: AuditQuery[] = []
  const exported = { fileName: 'telegram-bridge-audit-2026-11-25.csv', text: '"time","bridge"\n"2026-11-25T10:00:00.000Z","ci"' }
  const host = auditHost(queries, [auditEntry('a1')], botFocus('CIWatcher'), {
    results: { 'files.saveAs': { status: 'saved' } },
    requests: {
      'bridge.exportAudit': (input: AuditQuery) => {
        exportQueries.push(input)
        return exported
      }
    }
  })
  const view = await mount(panel, { host })
  await view.select(TABS, 'audit')
  await view.select({ label: 'Result' }, 'done')
  await view.press({ text: 'Export' })
  assert.equal(exportQueries.length, 1)
  assert.deepEqual(exportQueries[0], { bridgeId: 'ci', result: 'done' })
  assert.deepEqual(
    host.calls.filter((c) => c.method === 'files.saveAs').map((c) => c.params),
    [{ suggestedName: exported.fileName, mimeType: 'text/csv', data: exported.text }]
  )
  assert.ok(view.find({ text: 'Audit exported.' }))
  assert.deepEqual(view.refusals, [])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

const AUDIT_NOTICE = { label: 'Post a line in the group when someone changes its shared chat, sync or runs an automation' }

test('the Groups switch for audit lines starts from the saved value and is saved as groupAuditNotice', async () => {
  const saved: SaveConfigInput[] = []
  const state = makeState()
  const host = panelHost({
    requests: {
      'bridge.getState': () => state,
      'bridge.saveConfig': (input: SaveConfigInput) => {
        saved.push(input)
        return state
      }
    }
  })
  let view = await mount(panel, { host })
  await openEditor(view, 'b1')
  assert.equal(view.find(AUDIT_NOTICE)!.props.checked, false)
  await view.toggle(AUDIT_NOTICE)
  await view.press({ text: 'Save' })
  assert.equal(saved.length, 1)
  assert.equal(saved[0].groupAuditNotice, true)
  await view.unmount()

  const on = makeState({ bridges: [makeBridge('b1', { config: { groupAuditNotice: true } })] })
  view = await mount(panel, { host: panelHost({ requests: { 'bridge.getState': () => on } }) })
  await openEditor(view, 'b1')
  assert.equal(view.find(AUDIT_NOTICE)!.props.checked, true)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})
