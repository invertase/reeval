import type { HarnessV1Bootstrap } from '@ai-sdk/harness'

/** The SDK build the bootstrap installs. Bump it, then check the stream and endpoints still hold. */
export const CURSOR_SDK_VERSION = '1.0.40'

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
 * The runner's stored-conversation helpers, as the JavaScript it embeds, and which
 * {@link storedWebCalls} and {@link storedShapeProblems} run. Source text rather than a function's
 * `toString()`, which is whatever the compiler emitted (tsc for this package's dist, tsdown for
 * reeval's bundle): the bootstrap's content is the identity of the marker a baked image carries,
 * so an image baked by one build and run by another would rerun the install at every start.
 */
export const CURSOR_SDK_STORED_HELPERS = `function storedWebCalls(value, recovered = RECOVERED, found = []) {
  if (Array.isArray(value)) {
    for (const v of value) storedWebCalls(v, recovered, found)
  } else if (value && typeof value === 'object') {
    for (const [key, name] of Object.entries(recovered)) {
      if (value[key] && typeof value.toolCallId === 'string') {
        found.push({ name, id: value.toolCallId, at: value, call: value[key] })
      }
    }
    for (const v of Object.values(value)) storedWebCalls(v, recovered, found)
  }
  return found
}
function storedShapeProblems(value, calls, recovered = RECOVERED) {
  const problems = []
  const unknown = new Set()
  const walk = (v) => {
    if (Array.isArray(v)) for (const x of v) walk(x)
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (/^web\\w*ToolCall$/.test(k) && !(k in recovered)) unknown.add(k)
        walk(x)
      }
    }
  }
  walk(value)
  for (const k of unknown) problems.push(\`an unknown web tool call key \${k}\`)
  const target = { webFetch: 'url', webSearch: 'searchTerm' }
  for (const c of calls) {
    const at = \`\${c.name} \${c.id}\`
    const epoch = (x) => x !== undefined && x !== null && !Number.isNaN(Number(x))
    if (!epoch(c.at.startedAtMs)) problems.push(\`\${at}: no startedAtMs\`)
    if (!epoch(c.at.completedAtMs)) problems.push(\`\${at}: no completedAtMs\`)
    const args = c.call?.args
    const field = target[c.name]
    if (!args || typeof args !== 'object') problems.push(\`\${at}: no args\`)
    else if (field && typeof args[field] !== 'string') problems.push(\`\${at}: args has no \${field}\`)
    const result = c.call?.result
    if (!result || typeof result !== 'object' || !('success' in result || 'error' in result))
      problems.push(\`\${at}: result has neither success nor error\`)
  }
  return problems
}
const STORED_ONLY = ['beforeFullFileContent', 'afterFullFileContent', 'prevContent', 'interleavedOutput']
const storedMessage = (kind, v) =>
  [v.error, v.reason, v.clientVisibleError, v.message].find((m) => typeof m === 'string' && m) ?? kind
function storedResults(value, ids, found = []) {
  if (Array.isArray(value)) {
    for (const v of value) storedResults(v, ids, found)
  } else if (value && typeof value === 'object') {
    if (typeof value.toolCallId === 'string' && ids.has(value.toolCallId)) {
      for (const [key, call] of Object.entries(value)) {
        if (!key.endsWith('ToolCall') || !call?.result || typeof call.result !== 'object') continue
        const outcome = Object.entries(call.result).find(([, v]) => v && typeof v === 'object')
        if (!outcome) continue
        const [kind, v] = outcome
        // As the SDK's stream reports it: a command that exited non-zero is a success with its exit code.
        const succeeded = kind === 'success' || (key === 'shellToolCall' && kind === 'failure')
        const result = succeeded
          ? { status: 'success', value: Object.fromEntries(Object.entries(v).filter(([k]) => !STORED_ONLY.includes(k))) }
          : { status: 'error', error: { message: storedMessage(kind, v) } }
        found.push({ id: value.toolCallId, at: value, result })
      }
    }
    for (const v of Object.values(value)) storedResults(v, ids, found)
  }
  return found
}`

const stored = new Function(
  'RECOVERED',
  `${CURSOR_SDK_STORED_HELPERS}\nreturn { storedWebCalls, storedShapeProblems, storedResults }`,
)(CURSOR_SDK_RECOVERED_TOOLS) as {
  storedWebCalls: (
    value: unknown,
    recovered?: Record<string, string>,
    found?: StoredWebCall[],
  ) => StoredWebCall[]
  storedShapeProblems: (
    value: unknown,
    calls: StoredWebCall[],
    recovered?: Record<string, string>,
  ) => string[]
  storedResults: (value: unknown, ids: Set<string>) => StoredResult[]
}

/**
 * The web calls in `Agent.messages.list()`'s messages (as JSON), wherever they're nested: each is
 * a `ToolCall` whose oneof key is in `recovered`. The runner runs the same source.
 */
export const storedWebCalls = stored.storedWebCalls

/**
 * What's wrong with the stored conversation's web calls, by the fields the runner reads: each
 * call's `toolCallId`, `startedAtMs` and `completedAtMs`, its `args` (`url` for a fetch,
 * `searchTerm` for a search) and a `result` with `success` or `error`; and any web tool key the
 * runner doesn't know (a renamed `webFetchToolCall` would otherwise just find nothing). Empty when
 * the shape is as the runner expects. The runner runs the same source, and reports what it finds
 * as the turn's unreported tools, with this message.
 */
export const storedShapeProblems = stored.storedShapeProblems

/** A call's result in the stored conversation, in the stream's `tool_call` result shape. */
export type StoredResult = {
  id: string
  at: { startedAtMs?: unknown; completedAtMs?: unknown }
  result:
    | { status: 'success'; value: Record<string, unknown> }
    | { status: 'error'; error: { message: string } }
}

/**
 * The results the stored conversation holds for these call ids, whatever the tool: each is a
 * `ToolCall` whose `<tool>ToolCall` has a `result` oneof, `success` or a failure. The stream can
 * end a turn with a call it reported `running` and never completed; the store often has its
 * result. Each reads as the SDK's stream would report it: a shell's `failure` (a non-zero exit) is
 * a success with its `exitCode`, and any other failure an error with its message (`error`,
 * `reason` or `clientVisibleError`, else the oneof's case). A success drops the fields the store
 * adds and the stream doesn't send (whole file contents before and after an edit or delete, a
 * shell's interleaved output). The runner runs the same source.
 */
export const storedResults = stored.storedResults

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
${CURSOR_SDK_STORED_HELPERS}
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
    const streamed = new Map()
    const ended = new Set()
    for await (const event of run.stream()) {
      if (event.type === 'tool_call') {
        if (!streamed.has(event.call_id)) streamed.set(event.call_id, event.name)
        if (event.status && event.status !== 'running') ended.add(event.call_id)
      }
      out({ type: 'event', event })
    }
    const result = await run.wait()
    let messages
    try {
      if (before === undefined) throw new Error('the stored conversation could not be read before the turn')
      messages = await listMessages(turn)
      const calls = storedWebCalls(messages, RECOVERED)
      const problems = storedShapeProblems(messages, calls.filter((c) => !before.has(c.id)), RECOVERED)
      if (problems.length) throw new Error(\`the stored conversation's shape changed (@cursor/sdk \${turn.sdkVersion ?? '?'}): \${problems.join('; ')}\`)
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
    // Calls the stream left running: their results from the store, or none (the call stays unfinished).
    const unfinished = new Set([...streamed.keys()].filter((id) => !ended.has(id)))
    if (unfinished.size) {
      try {
        messages ??= await listMessages(turn)
        for (const c of storedResults(messages, unfinished)) {
          if (!unfinished.delete(c.id)) continue
          out({
            type: 'event',
            recovered: 'Agent.messages.list',
            event: {
              type: 'tool_call',
              agent_id: agent.agentId,
              run_id: result.id,
              call_id: c.id,
              name: streamed.get(c.id),
              status: c.result.status === 'success' ? 'completed' : 'error',
              result: c.result,
              started_at_ms: epochMs(c.at.startedAtMs),
              completed_at_ms: epochMs(c.at.completedAtMs),
            },
          })
        }
      } catch (error) {
        console.error(\`The stored conversation could not be read for unfinished tool calls: \${error?.message ?? error}\`)
      }
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
