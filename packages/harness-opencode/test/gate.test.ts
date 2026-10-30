import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import {
  OPENCODE_GATE,
  OPENCODE_GATE_ENV,
  OPENCODE_GATE_SERVERS_ENV,
} from '../src/opencode-gate.ts'

// The gate runs in reeval's Linux sandbox, where it execs OpenCode's bin by path; Windows can't run
// it or the stand-in, extensionless scripts with a shebang.
const skip = process.platform === 'win32' ? 'the gate and its stand-in are POSIX scripts' : false

const dir = mkdtempSync(join(tmpdir(), 'opencode-gate-'))
after(() => rmSync(dir, { recursive: true, force: true }))
const gate = join(dir, 'reeval-opencode-gate')
writeFileSync(gate, OPENCODE_GATE)
chmodSync(gate, 0o755)

/**
 * A stand-in for `opencode acp` beside the gate: it records each stdin line with the time and
 * its argv, and after 300 ms logs the connection OpenCode logs, as `--print-logs` writes it.
 */
const log = join(dir, 'seen.jsonl')
writeFileSync(
  join(dir, 'opencode'),
  `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
const t0 = Date.now()
const env = { AWS_REGION: process.env.AWS_REGION, EVAL_SET: process.env.EVAL_SET, gate: process.env.${OPENCODE_GATE_ENV} }
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), env }) + '\\n')
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) =>
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ ms: Date.now() - t0, line }) + '\\n'))
setTimeout(() => {
  process.stderr.write('not a log line\\n')
  process.stderr.write(process.env.CONNECT_LINE + '\\n')
}, 300)
`,
)
chmodSync(join(dir, 'opencode'), 0o755)

const CONNECTED =
  'timestamp=2026-09-28T06:34:11.857Z level=INFO message="mcp connected" server=stamp tools=1'

/** Runs the gate on `lines` and returns what the stand-in saw, and the gate's stderr. */
async function through(
  servers: string[],
  lines: string[],
  connect = CONNECTED,
  env: Record<string, string> = {},
) {
  writeFileSync(log, '')
  const child = spawn(gate, [], {
    env: {
      ...process.env,
      [OPENCODE_GATE_SERVERS_ENV]: JSON.stringify(servers),
      CONNECT_LINE: connect,
      ...env,
    },
    stdio: ['pipe', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (d) => (stderr += d))
  for (const line of lines) child.stdin.write(`${line}\n`)
  await new Promise((r) => setTimeout(r, 900))
  // The gate passes SIGTERM on, so the stand-in stops too.
  const exited = new Promise((r) => child.on('exit', r))
  child.kill('SIGTERM')
  await exited
  const seen = readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
  return {
    argv: seen[0].argv as string[],
    env: seen[0].env as Record<string, string | undefined>,
    lines: seen.slice(1) as { ms: number; line: string }[],
    stderr,
  }
}

const NEW = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/new', params: {} })
const PROMPT = JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'session/prompt', params: {} })
const CANCEL = JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: {} })

test('the first prompt waits for the MCP servers to connect, and what follows keeps its order', {
  skip,
}, async () => {
  const r = await through(['stamp'], [NEW, PROMPT, CANCEL])
  assert.deepEqual(r.argv, ['acp', '--print-logs', '--log-level', 'info'])
  assert.deepEqual(
    r.lines.map((l) => l.line),
    [NEW, PROMPT, CANCEL],
  )
  assert.ok(r.lines[0].ms < 250, `session/new passed straight through (${r.lines[0].ms} ms)`)
  // Connected at 300 ms, then the settle time.
  assert.ok(r.lines[1].ms >= 500, `the prompt waited (${r.lines[1].ms} ms)`)
  // OpenCode's logs stay with the gate; anything else on stderr passes through.
  assert.equal(r.stderr, 'not a log line\n')
})

test('twin: with no servers, or one that never connects, the prompt goes straight through or waits', {
  skip,
}, async () => {
  const none = await through([], [NEW, PROMPT])
  assert.deepEqual(none.argv, ['acp'])
  assert.ok(none.lines[1].ms < 250, `no servers: no wait (${none.lines[1].ms} ms)`)
  const other = await through(['docs'], [NEW, PROMPT])
  assert.deepEqual(
    other.lines.map((l) => l.line),
    [NEW],
    'still held for docs',
  )
})

test('a server that fails to connect releases the prompt too', { skip }, async () => {
  const failed = CONNECTED.replace('mcp connected', 'mcp connect failed')
  const r = await through(['stamp'], [NEW, PROMPT], failed)
  assert.deepEqual(
    r.lines.map((l) => l.line),
    [NEW, PROMPT],
  )
})

test("OpenCode gets the route's variables, over the sandbox's own, and not the gate's", {
  skip,
}, async () => {
  const r = await through([], [NEW], CONNECTED, {
    AWS_REGION: 'us-east-1',
    EVAL_SET: 'kept',
    [OPENCODE_GATE_ENV]: JSON.stringify({ AWS_REGION: 'eu-west-1' }),
  })
  assert.deepEqual(r.env, { AWS_REGION: 'eu-west-1', EVAL_SET: 'kept' })
  const none = await through([], [NEW], CONNECTED, { AWS_REGION: 'us-east-1' })
  assert.deepEqual(none.env, { AWS_REGION: 'us-east-1' })
})
