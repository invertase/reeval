import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { MCP_TIMER } from '../src/mcp-timer.ts'

type Message = Record<string, unknown>
const { scanner, handshake } = createRequire(import.meta.url)(MCP_TIMER) as {
  scanner: (onMessage: (m: Message) => void) => { push(chunk: Buffer): void }
  handshake: (onInitialized: () => void) => {
    fromClient(chunk: Buffer): void
    fromServer(chunk: Buffer): void
  }
}

const framed = (m: unknown) => {
  const body = Buffer.from(JSON.stringify(m))
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body])
}

/** Every message `scanner` reads from `chunks`, pushed one by one. */
function scan(chunks: Buffer[]): Message[] {
  const seen: Message[] = []
  const s = scanner((m) => seen.push(m))
  for (const c of chunks) s.push(c)
  return seen
}

/** `buffer` cut into pieces of `size` bytes, so messages (and characters) straddle chunks. */
const pieces = (buffer: Buffer, size: number) =>
  Array.from({ length: Math.ceil(buffer.length / size) }, (_, i) =>
    buffer.subarray(i * size, (i + 1) * size),
  )

describe('mcp-timer framing', () => {
  test('reads newline-delimited JSON-RPC across chunks, with CRLF, batches and noise', () => {
    const stream = Buffer.from(
      [
        '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"name":"é ü"}}',
        'not json: a server log line',
        '{"jsonrpc":"2.0","method":"notifications/initialized"}\r',
        '[{"jsonrpc":"2.0","id":2,"method":"tools/list"},{"jsonrpc":"2.0","id":3,"method":"ping"}]',
        '',
      ].join('\n'),
    )
    const messages = scan(pieces(stream, 7))
    assert.deepEqual(
      messages.map((m) => m.method),
      ['initialize', 'notifications/initialized', 'tools/list', 'ping'],
    )
    assert.deepEqual((messages[0]?.params as Message | undefined)?.name, 'é ü')
  })

  test('reads Content-Length framed messages, byte-counted, across chunks', () => {
    const stream = Buffer.concat([
      framed({ jsonrpc: '2.0', id: 'a', method: 'initialize', params: { note: 'naïve ☃' } }),
      framed({ jsonrpc: '2.0', id: 'a', result: { protocolVersion: '2025-06-18' } }),
    ])
    const messages = scan(pieces(stream, 5))
    assert.deepEqual(
      messages.map((m) => m.id),
      ['a', 'a'],
    )
    assert.deepEqual((messages[0]?.params as Message | undefined)?.note, 'naïve ☃')
  })

  test('the handshake ends on the answer to initialize’s id, not on other messages', () => {
    let initialized = 0
    const h = handshake(() => initialized++)
    const line = (m: unknown) => Buffer.from(`${JSON.stringify(m)}\n`)
    h.fromServer(line({ jsonrpc: '2.0', id: 7, result: {} }))
    h.fromClient(line({ jsonrpc: '2.0', id: 7, method: 'initialize', params: {} }))
    h.fromServer(line({ jsonrpc: '2.0', method: 'notifications/message', params: {} }))
    h.fromServer(line({ jsonrpc: '2.0', id: 8, result: {} }))
    assert.equal(initialized, 0)
    h.fromServer(line({ jsonrpc: '2.0', id: 7, error: { code: -32602, message: 'bad version' } }))
    h.fromServer(line({ jsonrpc: '2.0', id: 7, result: {} }))
    assert.equal(initialized, 1)
  })
})

describe('mcp-timer process', () => {
  const root = mkdtempSync(join(tmpdir(), 'reeval-mcp-timer-'))
  after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'bin'))
  const timer = join(root, 'bin', 'mcp-timer.cjs')
  copyFileSync(MCP_TIMER, timer)
  const log = join(root, 'mcp-startup.jsonl')
  const server = join(root, 'server.mjs')
  // Answers initialize after 150ms, echoes anything else back, and exits 3 when stdin ends.
  writeFileSync(
    server,
    `import { createInterface } from 'node:readline'
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line)
  if (m.method === 'initialize') setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18' } }) + '\\n'), 150)
  else process.stdout.write(line + '\\n')
}).on('close', () => setTimeout(() => process.exit(3), 200))
`,
  )

  /** Runs the timer on `args`, writes `input` and ends stdin; resolves with its stdout and exit code. */
  const run = (args: string[], input: string) =>
    new Promise<{ stdout: Buffer; code: number | null }>((resolve) => {
      const child = spawn(process.execPath, [timer, ...args], { stdio: ['pipe', 'pipe', 'ignore'] })
      const out: Buffer[] = []
      child.stdout.on('data', (c: Buffer) => out.push(c))
      child.on('close', (code) => resolve({ stdout: Buffer.concat(out), code }))
      child.stdin.write(input)
      setTimeout(() => child.stdin.end(), 400)
    })
  const entries = () =>
    readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))

  test('passes stdio through untouched and logs the initialize answer', async () => {
    rmSync(log, { force: true })
    const input = `${JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} })}\n{"jsonrpc":"2.0","method":"x","params":{"s":"☃"}}\n`
    const { stdout, code } = await run(['--name', 'echo', '--', process.execPath, server], input)
    assert.equal(code, 3, "the server's exit code")
    assert.equal(
      stdout.toString(),
      `{"jsonrpc":"2.0","method":"x","params":{"s":"☃"}}\n{"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-06-18"}}\n`,
    )
    const [entry, ...more] = entries()
    assert.deepEqual(more, [])
    assert.equal(entry.server, 'echo')
    assert.ok(entry.initializedAt - entry.spawnedAt >= 100, JSON.stringify(entry))
  })

  test('logs a server that exits before answering, with its exit code', async () => {
    rmSync(log, { force: true })
    const { code } = await run(
      ['--name', 'crash', '--', process.execPath, '-e', 'process.exit(5)'],
      `${JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} })}\n`,
    )
    assert.equal(code, 5)
    const [entry, ...more] = entries()
    assert.deepEqual(more, [])
    assert.deepEqual(
      { server: entry.server, exitCode: entry.exitCode, initializedAt: entry.initializedAt },
      { server: 'crash', exitCode: 5, initializedAt: undefined },
    )
  })

  test('logs a command that cannot start with the shell’s 127', async () => {
    rmSync(log, { force: true })
    const { code } = await run(['--name', 'missing', '--', 'reeval-no-such-command'], '')
    assert.equal(code, 127)
    assert.deepEqual(
      entries().map((e) => e.exitCode),
      [127],
    )
  })

  test('a client that closes stdin first leaves a closed start, not a timeout', async () => {
    rmSync(log, { force: true })
    // Never answers, and outlives its stdin, like a server a per-turn CLI left behind.
    const child = spawn(
      process.execPath,
      [timer, '--name', 'left', '--', process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      { stdio: ['pipe', 'ignore', 'ignore'] },
    )
    const closed = new Promise((resolve) => child.on('close', resolve))
    child.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize' })}\n`)
    const deadline = Date.now() + 10_000
    while (!readFileSync(log, { flag: 'a+' }).length && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
    }
    child.kill()
    await closed
    assert.deepEqual(
      entries().map((e) => [e.server, e.closed, e.timeout]),
      [['left', true, undefined]],
    )
  })

  test('past the scan limit it stops timing but keeps the server and its output', async () => {
    rmSync(log, { force: true })
    const noisy = join(root, 'noisy.mjs')
    writeFileSync(
      noisy,
      `process.stdout.write('x'.repeat(5 * 1024 * 1024) + '\\n')
process.stdin.on('data', () => process.stdout.write('{"jsonrpc":"2.0","id":0,"result":{}}\\n'))
`,
    )
    const { stdout, code } = await run(
      ['--name', 'noisy', '--', process.execPath, noisy],
      `${JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize' })}\n`,
    )
    assert.equal(code, 0)
    assert.equal(stdout.length, 5 * 1024 * 1024 + 1 + 37)
    assert.deepEqual(
      entries().map((e) => [e.server, e.unread]),
      [['noisy', true]],
    )
  })
})
