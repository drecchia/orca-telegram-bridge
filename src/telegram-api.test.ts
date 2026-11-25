import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { test } from 'node:test'
import { assert } from 'orca/testing'
import { createTelegramClient, splitTelegramMessage, TelegramApiError } from './telegram-api'

// Self-signed test-only certificate for api.telegram.org; trusted only via NODE_TLS_REJECT_UNAUTHORIZED below.
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg57BFix2QIXofeBwK
gSnmWhJl2087E5h0KuSU4ZZigfahRANCAASvFKo20NSIpHAUIjSsZlhS4Nnf3tic
cu8q/LHv5+2GtTmjS2sBiH2FWUkbDk1MCr5JjKhMpiSpk+Rdd85KcfNW
-----END PRIVATE KEY-----
`
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBjTCCATOgAwIBAgIUTM8pkk7iRgfrEMkwPFRK9C4riIAwCgYIKoZIzj0EAwIw
GzEZMBcGA1UEAwwQYXBpLnRlbGVncmFtLm9yZzAgFw0yNjExMjUxMjQxMTdaGA8y
MTI2MTEwMTEyNDExN1owGzEZMBcGA1UEAwwQYXBpLnRlbGVncmFtLm9yZzBZMBMG
ByqGSM49AgEGCCqGSM49AwEHA0IABK8UqjbQ1IikcBQiNKxmWFLg2d/e2Jxy7yr8
se/n7Ya1OaNLawGIfYVZSRsOTUwKvkmMqEymJKmT5F13zkpx81ajUzBRMB0GA1Ud
DgQWBBR5xCbmSIZZoNzhPWYza+YNoeZfqzAfBgNVHSMEGDAWgBR5xCbmSIZZoNzh
PWYza+YNoeZfqzAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0gAMEUCIQCZ
4NtadZ3KeX9EhSxEijTEaMl99Top2PSQbn7d67VorAIgDzm0yKlLKUTxLVbrZTs5
Kpq+//dqfok+jCJBY4sxVY8=
-----END CERTIFICATE-----
`

const TOKEN = '123456:TEST_TOKEN'
const client = createTelegramClient()

type FakeRequest = { path: string; body: string }

/**
 * Local HTTP CONNECT proxy whose tunnels end in a local TLS server playing api.telegram.org, so the
 * real transport (proxy agent, TLS, response handling) runs without network access.
 */
async function withFakeTelegram(
  handler: (req: FakeRequest, res: http.ServerResponse) => void,
  run: (proxyUrl: string) => Promise<void>
): Promise<void> {
  const api = https.createServer({ key: TEST_KEY, cert: TEST_CERT }, (req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => handler({ path: req.url || '', body: Buffer.concat(chunks).toString('utf8') }, res))
  })
  const sockets = new Set<net.Socket>()
  const proxy = net.createServer((socket) => {
    sockets.add(socket)
    socket.once('data', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n', () => api.emit('connection', socket))
    })
  })
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  const previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  try {
    await run(`http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`)
  } finally {
    if (previousTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls
    for (const s of sockets) s.destroy()
    proxy.close()
    api.close()
  }
}

test('a proxy that accepts TCP but never answers CONNECT times out', { timeout: 5000 }, async () => {
  const sockets = new Set<net.Socket>()
  const proxy = net.createServer((socket) => sockets.add(socket))
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  try {
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`
    await assert.rejects(
      client.getUpdates(TOKEN, { offset: 1, timeoutSec: 0 }, { proxyUrl, timeoutMs: 200 }),
      (err: unknown) => err instanceof TelegramApiError && /CONNECT timed out/.test(err.message)
    )
  } finally {
    for (const s of sockets) s.destroy()
    proxy.close()
  }
})

test('a connection dropped mid-body rejects instead of hanging', { timeout: 5000 }, async () => {
  await withFakeTelegram(
    (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '1000' })
      res.write('{"ok":true,"result":', () => res.socket?.destroy())
    },
    async (proxyUrl) => {
      await assert.rejects(client.getMe(TOKEN, { proxyUrl, timeoutMs: 3000 }), (err) => err instanceof TelegramApiError)
      await assert.rejects(
        client.downloadFile(TOKEN, 'photos/a.jpg', { proxyUrl, timeoutMs: 3000 }),
        (err) => err instanceof TelegramApiError
      )
    }
  )
})

test('sendMessage waits out a short 429 and sends again, keeping the reply when the original is gone', { timeout: 5000 }, async () => {
  const requests: FakeRequest[] = []
  await withFakeTelegram(
    (req, res) => {
      requests.push(req)
      res.setHeader('Content-Type', 'application/json')
      if (requests.length === 1) {
        res.statusCode = 429
        res.end(JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 0 } }))
        return
      }
      res.end(JSON.stringify({ ok: true, result: { message_id: 9, date: 1, chat: { id: 5, type: 'private' } } }))
    },
    async (proxyUrl) => {
      const message = await client.sendMessage(TOKEN, { chatId: 5, text: 'hi', replyToMessageId: 42 }, { proxyUrl })
      assert.equal(message.message_id, 9)
    }
  )
  assert.equal(requests.length, 2)
  const body = JSON.parse(requests[1].body) as Record<string, unknown>
  assert.deepEqual(body.reply_parameters, { message_id: 42, allow_sending_without_reply: true })
})

test('sendMessage does not block on a long flood wait', { timeout: 5000 }, async () => {
  let calls = 0
  await withFakeTelegram(
    (_req, res) => {
      calls++
      res.statusCode = 429
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 120 } }))
    },
    async (proxyUrl) => {
      await assert.rejects(
        client.sendMessage(TOKEN, { chatId: 5, text: 'hi' }, { proxyUrl }),
        (err: unknown) => err instanceof TelegramApiError && err.statusCode === 429 && err.retryAfterSec === 120
      )
    }
  )
  assert.equal(calls, 1)
})

test('getUpdates asks for membership changes and leaveChat posts the chat id', async () => {
  const requests: FakeRequest[] = []
  await withFakeTelegram(
    (req, res) => {
      requests.push(req)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ok: true, result: req.path.endsWith('/getUpdates') ? [] : true }))
    },
    async (proxyUrl) => {
      await client.getUpdates(TOKEN, { offset: 3, timeoutSec: 0 }, { proxyUrl })
      assert.equal(await client.leaveChat(TOKEN, -100500, { proxyUrl }), true)
    }
  )
  const [poll, leave] = requests
  const pollBody = JSON.parse(poll.body) as Record<string, unknown>
  assert.deepEqual(pollBody.allowed_updates, ['message', 'callback_query', 'my_chat_member'])
  assert.match(leave.path, /\/bot123456:TEST_TOKEN\/leaveChat$/)
  assert.deepEqual(JSON.parse(leave.body), { chat_id: -100500 })
})

// The working line is edited and deleted by id; a misspelled field would leave it in the chat.
test('editMessageText and deleteMessage send the chat and message ids as Telegram expects them', async () => {
  const requests: FakeRequest[] = []
  await withFakeTelegram(
    (req, res) => {
      requests.push(req)
      res.setHeader('Content-Type', 'application/json')
      res.end(
        req.path.endsWith('/editMessageText')
          ? JSON.stringify({ ok: true, result: { message_id: 77, date: 1, chat: { id: -100500, type: 'supergroup' } } })
          : JSON.stringify({ ok: true, result: true })
      )
    },
    async (proxyUrl) => {
      const edited = await client.editMessageText(TOKEN, { chatId: -100500, messageId: 77, text: '⏳ Working… 35s' }, { proxyUrl })
      assert.equal(edited.message_id, 77)
      assert.equal(await client.deleteMessage(TOKEN, -100500, 77, { proxyUrl }), true)
    }
  )
  const [edit, removed] = requests
  assert.match(edit.path, /\/bot123456:TEST_TOKEN\/editMessageText$/)
  assert.deepEqual(JSON.parse(edit.body), { chat_id: -100500, message_id: 77, text: '⏳ Working… 35s' })
  assert.match(removed.path, /\/bot123456:TEST_TOKEN\/deleteMessage$/)
  assert.deepEqual(JSON.parse(removed.body), { chat_id: -100500, message_id: 77 })
})

// The editor shows these names next to the listed IDs; a misspelled chat_id would leave every row blank.
test('getChat posts the chat id and returns the name fields', async () => {
  const requests: FakeRequest[] = []
  await withFakeTelegram(
    (req, res) => {
      requests.push(req)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ok: true, result: { id: 555, type: 'private', first_name: 'Ana', last_name: 'Lima', username: 'ana' } }))
    },
    async (proxyUrl) => {
      const chat = await client.getChat(TOKEN, 555, { proxyUrl })
      assert.equal(chat.username, 'ana')
      assert.equal(chat.last_name, 'Lima')
    }
  )
  assert.match(requests[0].path, /\/bot123456:TEST_TOKEN\/getChat$/)
  assert.deepEqual(JSON.parse(requests[0].body), { chat_id: 555 })
})

// Telegram ignores unknown fields, so a misspelled language_code would quietly drop the per-language menus.
test('setMyCommands sends language_code only for a language menu', async () => {
  const requests: FakeRequest[] = []
  await withFakeTelegram(
    (req, res) => {
      requests.push(req)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ok: true, result: true }))
    },
    async (proxyUrl) => {
      const commands = [{ command: 'help', description: 'Ayuda' }]
      await client.setMyCommands(TOKEN, commands, { proxyUrl })
      await client.setMyCommands(TOKEN, commands, { proxyUrl }, 'es')
    }
  )
  const [byDefault, spanish] = requests
  assert.match(byDefault.path, /\/setMyCommands$/)
  assert.deepEqual(JSON.parse(byDefault.body), { commands: [{ command: 'help', description: 'Ayuda' }] })
  assert.deepEqual(JSON.parse(spanish.body), { commands: [{ command: 'help', description: 'Ayuda' }], language_code: 'es' })
})

// A misspelled scope field would quietly set the menu for every chat instead of one.
test('setMyCommands and deleteMyCommands send a chat scope as Telegram expects it', async () => {
  const requests: FakeRequest[] = []
  await withFakeTelegram(
    (req, res) => {
      requests.push(req)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ok: true, result: true }))
    },
    async (proxyUrl) => {
      const commands = [{ command: 'help', description: 'Help' }]
      await client.setMyCommands(TOKEN, commands, { proxyUrl }, 'pt', { type: 'chat', chat_id: 42 })
      assert.equal(await client.deleteMyCommands(TOKEN, { proxyUrl }, { type: 'chat', chat_id: -100500 }, 'pt'), true)
      await client.deleteMyCommands(TOKEN, { proxyUrl }, { type: 'chat', chat_id: 7 })
    }
  )
  const [set, deleted, deletedNoLanguage] = requests
  assert.match(set.path, /\/setMyCommands$/)
  assert.deepEqual(JSON.parse(set.body), {
    commands: [{ command: 'help', description: 'Help' }],
    scope: { type: 'chat', chat_id: 42 },
    language_code: 'pt'
  })
  assert.match(deleted.path, /\/deleteMyCommands$/)
  assert.deepEqual(JSON.parse(deleted.body), { scope: { type: 'chat', chat_id: -100500 }, language_code: 'pt' })
  assert.deepEqual(JSON.parse(deletedNoLanguage.body), { scope: { type: 'chat', chat_id: 7 } })
})

test('an https:// proxy URL fails with a clear message', async () => {
  await assert.rejects(
    client.getMe(TOKEN, { proxyUrl: 'https://127.0.0.1:1', timeoutMs: 1000 }),
    /only http:\/\/ proxies are supported/
  )
})

test('splitTelegramMessage never splits an emoji into lone surrogates', () => {
  const text = 'a'.repeat(3999) + '😀' + 'b'.repeat(100)
  const chunks = splitTelegramMessage(text)
  assert.ok(chunks.length > 1)
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
  for (const chunk of chunks) {
    assert.ok(!loneSurrogate.test(chunk), `chunk has a lone surrogate: ${JSON.stringify(chunk.slice(-2))}`)
  }
  assert.equal(chunks.join(''), text)
})

const OK_MESSAGE = JSON.stringify({ ok: true, result: { message_id: 9, date: 1, chat: { id: 5, type: 'private' } } })

test('sendDocument uploads the bytes as the "document" field with their name, type and caption', async () => {
  const requests: FakeRequest[] = []
  await withFakeTelegram(
    (req, res) => {
      requests.push(req)
      res.setHeader('Content-Type', 'application/json')
      res.end(OK_MESSAGE)
    },
    async (proxyUrl) => {
      await client.sendDocument(
        TOKEN,
        {
          chatId: 5,
          document: Buffer.from('a,b\n1,2\n'),
          filename: 'data "q3".csv',
          contentType: 'text/csv',
          caption: 'Data',
          replyToMessageId: 42
        },
        { proxyUrl }
      )
    }
  )
  const [req] = requests
  assert.match(req.path, /\/sendDocument$/)
  // A quote in the name must not end the header value early.
  assert.ok(req.body.includes('name="document"; filename="data _q3_.csv"\r\nContent-Type: text/csv\r\n\r\na,b\n1,2\n'), req.body)
  assert.ok(req.body.includes('name="caption"\r\n\r\nData\r\n'), req.body)
  assert.ok(req.body.includes('"allow_sending_without_reply":true'), req.body)
})

test('sendPhoto uploads with the given content type and sends a URL string as JSON for Telegram to fetch', async () => {
  const requests: FakeRequest[] = []
  await withFakeTelegram(
    (req, res) => {
      requests.push(req)
      res.setHeader('Content-Type', 'application/json')
      res.end(OK_MESSAGE)
    },
    async (proxyUrl) => {
      await client.sendPhoto(
        TOKEN,
        { chatId: 5, photo: Buffer.from([0xff, 0xd8, 0xff]), filename: 'shot.jpg', contentType: 'image/jpeg' },
        { proxyUrl }
      )
      await client.sendPhoto(TOKEN, { chatId: 5, photo: 'https://example.com/logo.png', caption: 'Logo' }, { proxyUrl })
      await client.sendDocument(TOKEN, { chatId: 5, document: 'https://example.com/q3.xlsx' }, { proxyUrl })
    }
  )
  const [upload, photoByUrl, documentByUrl] = requests
  assert.ok(upload.body.includes('filename="shot.jpg"\r\nContent-Type: image/jpeg\r\n'), upload.body)
  assert.deepEqual(JSON.parse(photoByUrl.body), { chat_id: 5, photo: 'https://example.com/logo.png', caption: 'Logo' })
  assert.match(documentByUrl.path, /\/sendDocument$/)
  assert.deepEqual(JSON.parse(documentByUrl.body), { chat_id: 5, document: 'https://example.com/q3.xlsx' })
})
