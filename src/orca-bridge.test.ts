import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { assert } from 'orca/testing'
import {
  dispatchToOrcaBotAndWait,
  getOrcaBinary,
  isOrcaAutomationRunMessage,
  isOrcaOrchestrationMailMessage,
  isTelegramOriginatedUserMessage,
  listBotsLocalFirst,
  listLocalBots,
  OrcaCliError,
  parsePluginList,
  pickPluginKey,
  runOrcaJson,
  type OrcaChatSummary,
  type OrcaCliRunner,
  type OrcaSessionEntry,
  type OrcaSessionRead,
  withoutQuietMarker
} from './orca-bridge'
import type { BotSummary } from './protocol'

const BOUND_CHAT: OrcaChatSummary = {
  id: 'chat-1',
  title: 'Bound',
  lastActivityAt: 1000,
  lastAsked: null,
  lastSaid: null,
  home: false,
  self: false,
  closed: false
}

const user = (text: string): OrcaSessionEntry => ({ kind: 'message', role: 'user', text })
const assistant = (text: string, shortened?: boolean): OrcaSessionEntry =>
  shortened ? { kind: 'message', role: 'assistant', text, shortened } : { kind: 'message', role: 'assistant', text }

/**
 * Fake runner for an existing bound chat. `afterSend(poll, ourUser)` scripts each read made after
 * the message was sent; reads before the send see `beforeSend`. Reads honor `limit` like the CLI.
 */
function makeRunner(options: {
  beforeSend?: OrcaSessionRead
  afterSend: (poll: number, ourUser: OrcaSessionEntry) => OrcaSessionRead
  onRead?: (poll: number) => void
}) {
  const sentBodies: string[] = []
  const readLimits: number[] = []
  let postSendReads = 0
  const runner: OrcaCliRunner = {
    async listBots() {
      return []
    },
    async listBotChats() {
      return [BOUND_CHAT]
    },
    async readSession(_sessionId, limit = 40) {
      readLimits.push(limit)
      let session: OrcaSessionRead
      if (sentBodies.length === 0) {
        session = options.beforeSend ?? { orcaSessionId: BOUND_CHAT.id, state: 'done', entries: [] }
      } else {
        const poll = postSendReads++
        options.onRead?.(poll)
        session = options.afterSend(poll, user(sentBodies[0]))
      }
      return { ...session, entries: session.entries.slice(-limit) }
    },
    async renameChat() {},
    async listAutomations() {
      return []
    },
    async runAutomation() {},
    async listAutomationRuns() {
      return []
    },
    async sendToBot({ body }) {
      sentBodies.push(body)
    },
    async openPanel() {},
    async listPlugins() {
      return []
    }
  }
  return { runner, sentBodies, readLimits, postSendReads: () => postSendReads }
}

const dispatchParams = {
  botName: 'Assistant',
  boundChatId: BOUND_CHAT.id,
  tgChatId: '777',
  senderLabel: 'Ann (123)',
  userText: 'status?',
  timeoutMs: 2000,
  pollIntervalMs: 1
}

test('dispatch does not return the reply of the turn that was running when we sent', async () => {
  const oldTurn = [user('Earlier question'), assistant('Old partial')]
  const { runner } = makeRunner({
    beforeSend: { orcaSessionId: BOUND_CHAT.id, state: 'working', entries: oldTurn },
    afterSend: (poll, ourUser) => {
      const finishedOld = [...oldTurn, assistant('Old final answer')]
      if (poll === 0) return { orcaSessionId: BOUND_CHAT.id, state: 'done', entries: finishedOld }
      if (poll === 1) {
        return {
          orcaSessionId: BOUND_CHAT.id,
          state: 'working',
          entries: [...finishedOld, ourUser, assistant('Let me look')]
        }
      }
      return {
        orcaSessionId: BOUND_CHAT.id,
        state: 'done',
        entries: [...finishedOld, ourUser, assistant('Let me look'), assistant('Our answer')]
      }
    }
  })

  const result = await dispatchToOrcaBotAndWait(runner, dispatchParams)

  assert.equal(result.replyText, 'Let me look\n\nOur answer')
})

test('dispatch with an unknown turn state waits until the reply stops changing', async () => {
  const { runner } = makeRunner({
    afterSend: (poll, ourUser) => ({
      orcaSessionId: BOUND_CHAT.id,
      entries:
        poll === 0
          ? [ourUser, assistant('Let me check…')]
          : [ourUser, assistant('Let me check…'), assistant('Final answer')]
    })
  })

  const result = await dispatchToOrcaBotAndWait(runner, dispatchParams)

  assert.equal(result.replyText, 'Let me check…\n\nFinal answer')
  assert.equal(result.shortened, false)
})

test('dispatch finds the reply after a tool-heavy turn pushed our message out of the read window', async () => {
  const tools: OrcaSessionEntry[] = Array.from({ length: 150 }, () => ({ kind: 'tool' }))
  const { runner, readLimits } = makeRunner({
    afterSend: (poll, ourUser) =>
      poll === 0
        ? { orcaSessionId: BOUND_CHAT.id, state: 'working', entries: [ourUser, assistant('Working on it')] }
        : {
            orcaSessionId: BOUND_CHAT.id,
            state: 'done',
            entries: [ourUser, assistant('Working on it'), ...tools, assistant('Final summary')],
            limited: true
          }
  })

  const result = await dispatchToOrcaBotAndWait(runner, dispatchParams)

  assert.equal(result.replyText, 'Final summary')
  assert.ok(readLimits.every((limit) => limit === 100))
})

test('dispatch tells the Telegram user when Orca shortened the reply', async () => {
  const { runner } = makeRunner({
    afterSend: (_poll, ourUser) => ({
      orcaSessionId: BOUND_CHAT.id,
      state: 'done',
      entries: [ourUser, assistant('Very long reply', true)]
    })
  })

  const result = await dispatchToOrcaBotAndWait(runner, dispatchParams)

  assert.equal(result.replyText, 'Very long reply')
  assert.equal(result.shortened, true)
})

test('dispatch stops polling as soon as the signal aborts', { timeout: 5000 }, async () => {
  const controller = new AbortController()
  const { runner, postSendReads } = makeRunner({
    afterSend: (_poll, ourUser) => ({
      orcaSessionId: BOUND_CHAT.id,
      state: 'working',
      entries: [ourUser]
    }),
    onRead: (poll) => {
      if (poll === 1) controller.abort()
    }
  })

  await assert.rejects(
    dispatchToOrcaBotAndWait(runner, { ...dispatchParams, timeoutMs: 60_000, signal: controller.signal })
  )
  assert.equal(postSendReads(), 2)
})

test('dispatch does not send to the bot when aborted before sending', async () => {
  const controller = new AbortController()
  const { runner, sentBodies } = makeRunner({
    afterSend: () => ({ orcaSessionId: BOUND_CHAT.id, state: 'done', entries: [] })
  })
  const listBotChats = runner.listBotChats
  runner.listBotChats = async (botName) => {
    controller.abort()
    return listBotChats(botName)
  }

  await assert.rejects(dispatchToOrcaBotAndWait(runner, { ...dispatchParams, signal: controller.signal }))
  assert.equal(sentBodies.length, 0)
})

test('bridge-sent message is recognised when the sender label contains parentheses', async () => {
  const { runner, sentBodies } = makeRunner({
    afterSend: (_poll, ourUser) => ({
      orcaSessionId: BOUND_CHAT.id,
      state: 'done',
      entries: [ourUser, assistant('ok')]
    })
  })

  await dispatchToOrcaBotAndWait(runner, dispatchParams)

  assert.equal(isTelegramOriginatedUserMessage(sentBodies[0]), true)
  assert.match(sentBodies[0], /^Telegram message from user \(/)
  // Chat histories written before 0.3.0 still hold the old wording and must stay recognised.
  assert.equal(isTelegramOriginatedUserMessage('Telegram message from owner (Ann (123), chat 1) [tg:1:2].'), true)
  assert.equal(
    isTelegramOriginatedUserMessage('Did the Telegram message from owner (Ann, chat 1) [tg:1:2]. arrive?'),
    false
  )
})

test('an unaddressed group message gets its reply rule instead of "will be sent back"', async () => {
  const bodyFor = async (unaddressedGroupReply?: 'mentioned' | 'helpful') => {
    const { runner, sentBodies } = makeRunner({
      afterSend: (_poll, ourUser) => ({ orcaSessionId: BOUND_CHAT.id, state: 'done', entries: [ourUser, assistant('ok')] })
    })
    await dispatchToOrcaBotAndWait(runner, { ...dispatchParams, unaddressedGroupReply })
    return sentBodies[0]
  }
  const plain = (await bodyFor()).split('\n')
  assert.match(plain[1], /will be sent back to Telegram/)
  assert.match(plain[2], /^To send an image or file/)
  assert.equal(/not addressed to you/.test(plain.join('\n')), false)

  // Context only: no "sent back" promise and no attachment syntax.
  const silent = await bodyFor('mentioned')
  const silentLines = silent.split('\n')
  assert.match(silentLines[1], /^This group message was not addressed to you\. Read it for context only/)
  assert.equal(/will be sent back|To send an image or file/.test(silent), false)
  assert.equal(isTelegramOriginatedUserMessage(silent), true)
  assert.equal(silentLines.at(-1), 'status?')

  const helpful = (await bodyFor('helpful')).split('\n')
  assert.match(helpful[1], /^This group message was not addressed to you\. Reply only if you can clearly help/)
  assert.match(helpful[2], /^To send an image or file/)
  assert.equal(/will be sent back/.test(helpful.join('\n')), false)
})

test('a role prompt is fenced with a fresh nonce after the rules, before the user text', async () => {
  const bodyFor = async (rolePrompt?: string) => {
    const { runner, sentBodies } = makeRunner({
      afterSend: (_poll, ourUser) => ({ orcaSessionId: BOUND_CHAT.id, state: 'done', entries: [ourUser, assistant('ok')] })
    })
    await dispatchToOrcaBotAndWait(runner, { ...dispatchParams, rolePrompt })
    return sentBodies[0]
  }
  const first = await bodyFor('  Only talk about billing.  ')
  const lines = first.split('\n')
  assert.match(lines[0], /^Telegram message from user \(/)
  assert.equal(isTelegramOriginatedUserMessage(first), true)
  assert.equal(lines.at(-1), 'status?')
  const open = lines.findIndex((l) => /^Owner's instructions for this user's role \(not written by the user\) \[role:[0-9a-f]{16}\]:$/.test(l))
  assert.ok(open > lines.findIndex((l) => /^To send an image or file/.test(l)))
  const nonce = /\[role:([0-9a-f]+)\]/.exec(lines[open])![1]
  assert.equal(lines[open + 1], 'Only talk about billing.')
  assert.equal(lines[open + 2], `[/role:${nonce}]`)

  const second = await bodyFor('Only talk about billing.')
  assert.equal(second.includes(`[role:${nonce}]`), false)

  for (const none of [undefined, '', '   ']) {
    assert.equal(/\[role:|Owner's instructions/.test(await bodyFor(none)), false)
  }
})

test('files are listed after the images with their original name; without a caption the user asks to open them', async () => {
  const linesFor = async (userText: string) => {
    const { runner, sentBodies } = makeRunner({
      afterSend: (_poll, ourUser) => ({ orcaSessionId: BOUND_CHAT.id, state: 'done', entries: [ourUser, assistant('ok')] })
    })
    await dispatchToOrcaBotAndWait(runner, {
      ...dispatchParams,
      userText,
      imagePaths: ['/tmp/images/tg-1-2-ab.jpg'],
      // A name with a line break stays on its line.
      files: [{ path: '/tmp/files/tg-1-2-ab-Q3_report.xlsx', name: 'Q3\nreport.xlsx' }]
    })
    return sentBodies[0].split('\n')
  }
  const lines = await linesFor('')
  const images = lines.findIndex((l) => l.startsWith('Attached Telegram image(s)'))
  const files = lines.indexOf(
    'Attached Telegram file(s) saved locally (open them with your tools; the original name is in parentheses):'
  )
  assert.ok(images >= 0 && files > images)
  assert.equal(lines[files + 1], '- /tmp/files/tg-1-2-ab-Q3_report.xlsx (Q3 report.xlsx)')
  assert.equal(lines.at(-1), 'Please open the attached file(s) above and respond.')

  assert.equal((await linesFor('Sum column B')).at(-1), 'Sum column B')
})

test('getOrcaBinary uses orca-ide on Linux, never the GNOME screen reader', () => {
  const env: NodeJS.ProcessEnv = {}
  const bundled = '/opt/Orca/resources/bin/orca-ide'
  assert.equal(getOrcaBinary('linux', '/opt/Orca/orca', env, (f) => f === bundled), bundled)
  assert.equal(getOrcaBinary('linux', '/opt/Orca/orca', env, () => false), 'orca-ide')
  assert.equal(getOrcaBinary('darwin', '/Applications/Orca.app/Contents/MacOS/Orca', env, () => false), 'orca')
  assert.equal(
    getOrcaBinary('linux', '/opt/Orca/orca', { ORCA_CLI: '/custom/orca' }, (f) => f === '/custom/orca'),
    '/custom/orca'
  )
})

async function withOrcaCli<T>(bin: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.ORCA_CLI
  process.env.ORCA_CLI = bin
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.ORCA_CLI
    else process.env.ORCA_CLI = previous
  }
}

test('runOrcaJson with an already-aborted signal rejects as aborted', async () => {
  const controller = new AbortController()
  controller.abort()
  await withOrcaCli(process.execPath, () =>
    assert.rejects(runOrcaJson(['-e', ''], { signal: controller.signal }), /aborted/)
  )
})

test('runOrcaJson survives a CLI that exits without reading its stdin', { timeout: 10_000 }, async () => {
  // Several MB of stdin to a process that exits at once raises EPIPE/EOF on the pipe.
  await withOrcaCli(process.execPath, () =>
    assert.rejects(
      runOrcaJson(['-e', 'process.exit(0)'], { stdinText: 'x'.repeat(4 * 1024 * 1024) }),
      /non-JSON/
    )
  )
  // Give a late pipe error the chance to surface as an uncaught exception inside this test.
  await new Promise((resolve) => setImmediate(resolve))
})

async function cliErrorOf(run: Promise<unknown>): Promise<OrcaCliError> {
  try {
    await run
  } catch (err) {
    if (err instanceof OrcaCliError) return err
    throw err
  }
  throw new Error('runOrcaJson resolved; expected an OrcaCliError')
}

test('a CLI that exits non-zero rejects with its args, exit code and stderr', { timeout: 10_000 }, async () => {
  const args = ['-e', "process.stderr.write('bot not found: Ghost'); process.exit(3)"]
  const err = await withOrcaCli(process.execPath, () => cliErrorOf(runOrcaJson(args)))
  assert.equal(err.kind, 'exit')
  assert.equal(err.exitCode, 3)
  assert.equal(err.stderr, 'bot not found: Ghost')
  assert.equal(err.message, 'bot not found: Ghost')
  assert.deepEqual(err.args, args)
  assert.ok(err.durationMs >= 0)
})

test('non-JSON CLI output is reported by size, never by content', { timeout: 10_000 }, async () => {
  const err = await withOrcaCli(process.execPath, () =>
    cliErrorOf(runOrcaJson(['-e', "process.stdout.write('session secret text')"]))
  )
  assert.equal(err.kind, 'json')
  assert.equal(err.exitCode, 0)
  assert.equal(err.stdoutBytes, Buffer.byteLength('session secret text'))
  assert.match(err.message, /non-JSON/)
  assert.ok(!err.message.includes('session secret text'))
})

test('an already-aborted signal rejects with kind aborted and masks text arguments', async () => {
  const controller = new AbortController()
  controller.abort()
  const err = await cliErrorOf(
    runOrcaJson(['orchestration', 'send', '--subject', 'Telegram: my private words', '--json'], {
      signal: controller.signal
    })
  )
  assert.equal(err.kind, 'aborted')
  assert.equal(err.exitCode, null)
  assert.deepEqual(err.args, ['orchestration', 'send', '--subject', '<26 chars>', '--json'])
})

async function withBotsRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tg-bridge-bots-'))
  try {
    return await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function writeBotFolder(root: string, folder: string, files: Record<string, string>): Promise<void> {
  await mkdir(path.join(root, folder), { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(root, folder, name), content, 'utf8')
  }
}

test('local bot folders list only valid bots, sorted, with SOUL.md specialty', async () => {
  await withBotsRoot(async (root) => {
    // Folder order (ciwatcher, zed) and case-sensitive order (C < a) both differ from the wanted order.
    await writeBotFolder(root, 'zed', {
      'bot.json': JSON.stringify({ id: 'id-alpha', name: 'alpha', agent: 'codex' }),
      'SOUL.md': '# Alpha\n\n## Role\n\nWatches the  deploys\nand reports.\n\nSecond paragraph.\n'
    })
    await writeBotFolder(root, 'ciwatcher', {
      'bot.json': JSON.stringify({ id: 'id-ci', name: 'CIWatcher', avatar: 'x' })
    })
    await writeBotFolder(root, 'no-meta', { 'SOUL.md': 'Not a bot.' })
    await writeBotFolder(root, 'broken', { 'bot.json': '{ not json' })
    await writeBotFolder(root, 'no-name', { 'bot.json': JSON.stringify({ id: 'id-anon' }) })

    const bots = await listLocalBots(root)

    assert.deepEqual(bots, [
      { id: 'id-alpha', name: 'alpha', specialty: 'Watches the deploys and reports.', agent: 'codex' },
      { id: 'id-ci', name: 'CIWatcher', specialty: '', agent: 'claude' }
    ])
  })
})

test('a long SOUL.md paragraph is cut so the panel list stays short', async () => {
  await withBotsRoot(async (root) => {
    await writeBotFolder(root, 'talker', {
      'bot.json': JSON.stringify({ id: 'id-talk', name: 'Talker' }),
      'SOUL.md': 'word '.repeat(100)
    })
    const [bot] = await listLocalBots(root)
    assert.ok(bot.specialty.length <= 200, `specialty has ${bot.specialty.length} chars`)
    assert.match(bot.specialty, /^word word .*…$/)
  })
})

test('a missing or empty bots folder yields no local bots', async () => {
  await withBotsRoot(async (root) => {
    assert.deepEqual(await listLocalBots(root), [])
    assert.deepEqual(await listLocalBots(path.join(root, 'does-not-exist')), [])
  })
})

const CLI_BOT: BotSummary = { id: 'id-remote', name: 'Remote', specialty: 'From CLI', agent: 'claude' }

test('listing bots uses local folders and never waits on the CLI when any exist', async () => {
  await withBotsRoot(async (root) => {
    await writeBotFolder(root, 'ciwatcher', {
      'bot.json': JSON.stringify({ id: 'id-ci', name: 'CIWatcher', agent: 'claude' })
    })
    let cliCalls = 0
    const bots = await listBotsLocalFirst(root, async () => {
      cliCalls++
      return [CLI_BOT]
    })
    assert.deepEqual(bots.map((b) => b.name), ['CIWatcher'])
    assert.equal(cliCalls, 0)
  })
})

test('listing bots falls back to the CLI when no local bot is readable', async () => {
  await withBotsRoot(async (root) => {
    await writeBotFolder(root, 'broken', { 'bot.json': '{ not json' })
    const bots = await listBotsLocalFirst(root, async () => [CLI_BOT])
    assert.deepEqual(bots, [CLI_BOT])
  })
})

test('the plugin list is read from its plugins array and keeps only what the key choice needs', () => {
  const result = {
    plugins: [
      { pluginKey: 'drecchia.telegram-bridge', isDev: false, status: 'running', name: 'Telegram Bridge', version: '0.5.0' },
      { pluginKey: 'local.telegram-bridge', isDev: true, status: 'disabled' },
      { name: 'no key' },
      'junk'
    ]
  }
  assert.deepEqual(parsePluginList(result), [
    { pluginKey: 'drecchia.telegram-bridge', isDev: false, status: 'running' },
    { pluginKey: 'local.telegram-bridge', isDev: true, status: 'disabled' }
  ])
  assert.deepEqual(parsePluginList({ ok: true }), [])
})

test('the plugin key prefers the dev copy, then a running one, and ignores other plugins', () => {
  const installed = { pluginKey: 'drecchia.telegram-bridge', isDev: false, status: 'running' }
  const devStopped = { pluginKey: 'local.telegram-bridge', isDev: true, status: 'disabled' }
  const devRunning = { pluginKey: 'work.telegram-bridge', isDev: true, status: 'running' }
  const other = { pluginKey: 'drecchia.telegram-bridge-extras', isDev: true, status: 'running' }
  assert.equal(pickPluginKey([installed], 'telegram-bridge'), 'drecchia.telegram-bridge')
  assert.equal(pickPluginKey([installed, devStopped], 'telegram-bridge'), 'local.telegram-bridge')
  assert.equal(pickPluginKey([devStopped, installed, devRunning], 'telegram-bridge'), 'work.telegram-bridge')
  assert.equal(pickPluginKey([other], 'telegram-bridge'), null)
  assert.equal(pickPluginKey([], 'telegram-bridge'), null)
})

test('Orca automation runs are recognised by the line Orca adds, typed messages are not', () => {
  // The shapes Orca writes (automation-event-prompt.ts), as seen in a real bound chat.
  assert.equal(
    isOrcaAutomationRunMessage(
      'Reminder for the Telegram user. Reply with exactly this text.\n\n[Orca: it is 2026-11-25T16:27:59.000Z, the time you were asked to act at. This is the only run.]'
    ),
    true
  )
  assert.equal(
    isOrcaAutomationRunMessage(
      'Check the build.\n\n[Orca: the deadline 2026-11-25T18:00:00.000Z came before the event you were waiting for. This is the wait\'s only run.]'
    ),
    true
  )
  assert.equal(
    isOrcaAutomationRunMessage('Summarize it.\n\n[Orca event: Slack · message · 2026-11-25T10:00:00.000Z]\n[Orca: this came from your owner.]'),
    true
  )
  assert.equal(isOrcaAutomationRunMessage('Check today tasks in Orca'), false)
  // Quoting the line inside a sentence is not a run.
  assert.equal(isOrcaAutomationRunMessage('Why did it say [Orca: it is X, the time you were asked to act at. This is the only run.] ?'), false)
})

test('mail from another agent is recognised by Orca\'s banner, typed messages are not', () => {
  // The shape Orca wrote into a bound chat when its bot's Home Chat sent a handoff.
  assert.equal(
    isOrcaOrchestrationMailMessage(
      '──── From: ORCA_SESSION_ID:9863D830 (orca_session_id:9863d830) (handoff) ────\nSubject: Release note\nSend this to the user.\n[Reply: orca orchestration reply --id msg_074f0a5c23fc --body "..."]\n────────────────────────────────────────────────────────────'
    ),
    true
  )
  assert.equal(isOrcaOrchestrationMailMessage('──── From: TERM_WORKER (term_worker) [URGENT] (question) ────\nSubject: x'), true)
  assert.equal(isOrcaOrchestrationMailMessage('Check today tasks in Orca'), false)
  // Quoting a banner after other words is something the owner typed.
  assert.equal(isOrcaOrchestrationMailMessage('Why did I get\n──── From: X (x) (handoff) ────'), false)
})

test('NO_REPLY answers say nothing; words before the marker stay; a quoted mention stays', () => {
  assert.equal(withoutQuietMarker('NO_REPLY'), null)
  assert.equal(withoutQuietMarker('**NO_REPLY.**\n'), null)
  assert.equal(withoutQuietMarker('`NO_REPLY`'), null)
  assert.equal(withoutQuietMarker('Nothing changed. NO_REPLY'), 'Nothing changed.')
  assert.equal(withoutQuietMarker('Answer NO_REPLY NO_REPLY'), 'Answer')
  assert.equal(withoutQuietMarker('To stay silent, end with `NO_REPLY`'), 'To stay silent, end with `NO_REPLY`')
  assert.equal(withoutQuietMarker('XNO_REPLY'), 'XNO_REPLY')
  assert.equal(withoutQuietMarker('⏰ Lembrete: conferir o saldo.'), '⏰ Lembrete: conferir o saldo.')
})
