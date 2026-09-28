/**
 * The gate's name, `executable` for `harness-acp`, which takes a bare name and runs
 * `<implementation>/node_modules/.bin/<executable>`: the gate goes beside OpenCode's own bin.
 */
export const OPENCODE_GATE_EXECUTABLE = 'reeval-opencode-gate'

/** Where the gate goes, under the sandbox home. */
export const OPENCODE_GATE_PATH = `.ai-sdk-harness/.harness-bootstrap/opencode/implementation/node_modules/.bin/${OPENCODE_GATE_EXECUTABLE}`

/** The variable that names the MCP servers the gate waits for, as a JSON list. */
export const OPENCODE_GATE_SERVERS_ENV = 'REEVAL_OPENCODE_MCP_SERVERS'

/** How long the first prompt waits for the MCP servers at most, in ms. */
export const OPENCODE_GATE_TIMEOUT_MS = 30_000

/**
 * How long after the last server connects the prompt still waits, in ms: OpenCode adds its
 * tools to the session's tool list from events it publishes after logging the connection.
 */
export const OPENCODE_GATE_SETTLE_MS = 250

/**
 * The gate `harness-acp` runs in front of `opencode acp`. OpenCode 2.0.18 connects the MCP servers
 * in its config in the background once `session/new` has returned, and a prompt sent before
 * they're connected runs its first step without their tools. The gate holds the first
 * `session/prompt` (and what follows it) until each server named in
 * `REEVAL_OPENCODE_MCP_SERVERS` has logged `mcp connected` or `mcp connect failed` (and
 * {@link OPENCODE_GATE_SETTLE_MS} has passed), or the timeout passes. With servers to wait for, OpenCode runs with its info logs on stderr, which the gate
 * reads and keeps; anything else on stderr passes through.
 */
export const OPENCODE_GATE = `#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pending = new Set(JSON.parse(process.env.${OPENCODE_GATE_SERVERS_ENV} || '[]'))
const logs = pending.size > 0 ? ['--print-logs', '--log-level', 'info'] : []
const child = spawn(join(here, 'opencode'), ['acp', ...logs], {
  stdio: ['pipe', 'inherit', 'pipe'],
})
let held = null
let ended = false
const release = () => {
  if (held === null) return
  for (const line of held) child.stdin.write(line + '\\n')
  held = null
  if (ended) child.stdin.end()
}
const timer = setTimeout(() => {
  pending.clear()
  release()
}, ${OPENCODE_GATE_TIMEOUT_MS})
timer.unref()
createInterface({ input: child.stderr }).on('line', (line) => {
  if (!line.startsWith('timestamp=')) return process.stderr.write(line + '\\n')
  const event = /message="mcp (connected|connect failed)"/.test(line)
  const server = /\\bserver=(?:"((?:[^"\\\\]|\\\\.)*)"|(\\S+))/.exec(line)
  if (!event || !server) return
  pending.delete(server[1] ?? server[2])
  if (pending.size === 0) setTimeout(release, ${OPENCODE_GATE_SETTLE_MS})
})
createInterface({ input: process.stdin }).on('line', (line) => {
  if (held === null && pending.size > 0 && /"method"\\s*:\\s*"session\\/prompt"/.test(line)) held = []
  if (held !== null) held.push(line)
  else child.stdin.write(line + '\\n')
}).on('close', () => {
  ended = true
  if (held === null) child.stdin.end()
})
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal))
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
`
