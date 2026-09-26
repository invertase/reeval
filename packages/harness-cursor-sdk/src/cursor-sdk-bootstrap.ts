import type { HarnessV1Bootstrap } from '@ai-sdk/harness'

/** The SDK build the bootstrap installs. Bump it, then check the stream and endpoints still hold. */
export const CURSOR_SDK_VERSION = '1.0.32'

/**
 * Built-in tools whose calls never reach the stream at {@link CURSOR_SDK_VERSION}: Cursor's
 * backend sends them, but the SDK's interaction-update converter maps `webSearchToolCall` and
 * `webFetchToolCall` to null, so neither `run.stream()` nor `onDelta` / `onStep` sees them. The
 * agent's stored conversation (`Agent.messages.list`) keeps them, with args, results and times,
 * so the runner reports them from there after each turn, as `tool_call` events marked
 * `recovered`. When it can't, the turn's `harnessMetadata.cursorSdk.unreportedTools` lists them.
 */
export const CURSOR_SDK_RECOVERED_TOOLS = {
  webSearchToolCall: 'webSearch',
  webFetchToolCall: 'webFetch',
} as const

/** A web call in the stored conversation: `at` holds its `startedAtMs` and `completedAtMs`. */
export type StoredWebCall = {
  name: string
  id: string
  at: { startedAtMs?: unknown; completedAtMs?: unknown }
  call: { args?: Record<string, unknown>; result?: { success?: unknown; error?: unknown } }
}

/**
 * The web calls in `Agent.messages.list()`'s messages (as JSON), wherever they're nested: each is
 * a `ToolCall` whose oneof key is in `recovered`. The runner embeds this function's source.
 */
export function storedWebCalls(
  value: unknown,
  recovered: Record<string, string> = CURSOR_SDK_RECOVERED_TOOLS,
  found: StoredWebCall[] = [],
): StoredWebCall[] {
  if (Array.isArray(value)) {
    for (const v of value) storedWebCalls(v, recovered, found)
  } else if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    for (const [key, name] of Object.entries(recovered)) {
      if (o[key] && typeof o.toolCallId === 'string') {
        found.push({ name, id: o.toolCallId, at: o, call: o[key] as StoredWebCall['call'] })
      }
    }
    for (const v of Object.values(o)) storedWebCalls(v, recovered, found)
  }
  return found
}

/** Relative to the harness state directory, `$HOME/.ai-sdk-harness`. */
export const CURSOR_SDK_BOOTSTRAP_DIR = '.harness-bootstrap/cursor-sdk'
/** The runner's path relative to the bootstrap directory. */
export const CURSOR_SDK_RUNNER_PATH = 'runner.mjs'

/**
 * The SDK needs Node 22.13; routing its requests through `HTTPS_PROXY` (`NODE_USE_ENV_PROXY`)
 * needs 22.21, and a sandbox that brokers the key has no other way out.
 */
export const CURSOR_SDK_MIN_NODE = '22.21.0'

/** The file the adapter writes once a turn's request is complete, so the runner never reads half. */
export const cursorSdkTurnReady = (turn: number) => `turn-${turn}.ready`

/**
 * Runs a session's turns in the sandbox, one process for as long as it lives: it waits for each
 * turn's request (`turn-<n>.json`, then `turn-<n>.ready`) in the session directory, creates the
 * agent on the first (or resumes it by id from its JSONL store), sends the prompt and prints one
 * JSON line per event on stdout, then a `result` line. The agent stays loaded between turns, so a
 * follow-up turn skips Node's start, the SDK's import and the resume. The SDK logs to stdout, so
 * everything but those lines goes to stderr.
 */
export const CURSOR_SDK_RUNNER = `// A local Cursor SDK agent's turns, as NDJSON on stdout.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const write = process.stdout.write.bind(process.stdout)
process.stdout.write = process.stderr.write.bind(process.stderr)
const out = (line) => write(\`\${JSON.stringify(line)}\\n\`)
const dir = process.argv[2]
let n = Number(process.argv[3] ?? 1)

let sdk
try {
  sdk = await import('@cursor/sdk')
} catch (error) {
  out({ type: 'error', turn: n, message: \`The Cursor SDK didn't load: \${error?.message ?? error}\` })
  process.exit(1)
}
const { Agent, Cursor, JsonlLocalAgentStore } = sdk

// Over HTTP/2 the agent's stream connects directly, ignoring HTTPS_PROXY; over HTTP/1.1 it
// goes through the proxy like every other request.
Cursor.configure({ local: { useHttp1ForAgent: true } })

const RECOVERED = ${JSON.stringify(CURSOR_SDK_RECOVERED_TOOLS)}
const storedWebCalls = ${storedWebCalls.toString()}
const epochMs = (v) => (v === undefined || v === null || Number.isNaN(Number(v)) ? undefined : Number(v))
// As JSON: in memory they're protobuf messages, whose oneofs are { case, value }.
const listMessages = async (turn) =>
  JSON.parse(JSON.stringify(await Agent.messages.list(agent.agentId, { cwd: turn.cwd, store })))

let agent
let run
let store
let stopping = false
const stop = () => {
  stopping = true
  if (run) void run.cancel().catch(() => {})
  else process.exit(130)
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)

for (; !stopping; n++) {
  while (!existsSync(join(dir, \`turn-\${n}.ready\`))) await sleep(15)
  const turn = JSON.parse(readFileSync(join(dir, \`turn-\${n}.json\`), 'utf8'))
  const prompt = readFileSync(turn.promptFile, 'utf8')
  const started = Date.now()
  try {
    if (!agent) {
      store = new JsonlLocalAgentStore(turn.storeDir)
      const options = {
        apiKey: process.env.CURSOR_API_KEY,
        ...(turn.model ? { model: turn.model } : {}),
        local: {
          cwd: turn.cwd,
          store,
          settingSources: turn.settingSources,
          ...(turn.sandbox ? { sandboxOptions: { enabled: true } } : {}),
        },
        ...(turn.mcpServers ? { mcpServers: turn.mcpServers } : {}),
      }
      agent = turn.agentId ? await Agent.resume(turn.agentId, options) : await Agent.create(options)
    }
    out({ type: 'init', turn: n, agentId: agent.agentId, model: agent.model, sdkVersion: turn.sdkVersion })
    // Stored messages are updated in place, so earlier turns' calls are told apart by id.
    const before = await listMessages(turn).then(
      (m) => new Set(storedWebCalls(m, RECOVERED).map((c) => c.id)),
      () => undefined,
    )
    run = await agent.send(prompt)
    const streamed = new Set()
    for await (const event of run.stream()) {
      if (event.type === 'tool_call') streamed.add(event.call_id)
      out({ type: 'event', event })
    }
    const result = await run.wait()
    try {
      if (before === undefined) throw new Error('the stored conversation could not be read before the turn')
      const calls = storedWebCalls(await listMessages(turn), RECOVERED)
      for (const c of calls.filter((c) => !before.has(c.id) && !streamed.has(c.id))) {
        const { toolCallId, ...args } = c.call.args ?? {}
        const base = { type: 'tool_call', agent_id: agent.agentId, run_id: result.id, call_id: c.id, name: c.name, args }
        out({ type: 'event', recovered: 'Agent.messages.list', event: { ...base, status: 'running', started_at_ms: epochMs(c.at.startedAtMs) } })
        const r = c.call.result
        const failed = !r?.success
        out({
          type: 'event',
          recovered: 'Agent.messages.list',
          event: {
            ...base,
            status: failed ? 'error' : 'completed',
            result: failed ? { status: 'error', error: r?.error ?? r ?? 'no result' } : { status: 'success', value: r.success },
            started_at_ms: epochMs(c.at.startedAtMs),
            completed_at_ms: epochMs(c.at.completedAtMs),
          },
        })
      }
    } catch (error) {
      out({ type: 'unreported', turn: n, tools: Object.values(RECOVERED), message: String(error?.message ?? error) })
    }
    out({
      type: 'result',
      turn: n,
      agentId: agent.agentId,
      runId: result.id,
      requestId: result.requestId,
      status: result.status,
      result: result.result,
      error: result.error,
      model: result.model,
      durationMs: result.durationMs ?? Date.now() - started,
      usage: result.usage,
    })
  } catch (error) {
    out({
      type: 'error',
      turn: n,
      message: String(error?.message ?? error),
      name: error?.name,
      code: error?.code,
      status: error?.status,
    })
    // The next turn starts from the store, not from an agent in an unknown state.
    await agent?.[Symbol.asyncDispose]?.().catch(() => {})
    agent = undefined
  } finally {
    run = undefined
  }
}
await agent?.[Symbol.asyncDispose]?.().catch(() => {})
process.exit(130)
`

/** Checks Node, then installs the pinned SDK (and its platform package) next to the runner. */
export function cursorSdkInstallScript(version = CURSOR_SDK_VERSION): string {
  return `set -eu
node -e 'const [a,b]=process.versions.node.split(".").map(Number);const [x,y]="${CURSOR_SDK_MIN_NODE}".split(".").map(Number);if(a<x||(a===x&&b<y)){console.error("The Cursor SDK harness needs Node ${CURSOR_SDK_MIN_NODE} or later (found "+process.versions.node+")");process.exit(1)}'
cat > package.json <<'JSON'
{ "private": true, "type": "module", "dependencies": { "@cursor/sdk": "${version}" } }
JSON
npm install --omit=dev --no-audit --no-fund --loglevel=error
node -e 'import("@cursor/sdk").then(() => console.log("@cursor/sdk ${version}"))'
`
}

export async function getCursorSdkBootstrap(): Promise<HarnessV1Bootstrap> {
  return {
    harnessId: 'cursor-sdk',
    bootstrapDir: CURSOR_SDK_BOOTSTRAP_DIR,
    files: [
      { path: `${CURSOR_SDK_BOOTSTRAP_DIR}/install.sh`, content: cursorSdkInstallScript() },
      { path: `${CURSOR_SDK_BOOTSTRAP_DIR}/${CURSOR_SDK_RUNNER_PATH}`, content: CURSOR_SDK_RUNNER },
    ],
    commands: [{ command: 'sh install.sh' }],
  }
}
