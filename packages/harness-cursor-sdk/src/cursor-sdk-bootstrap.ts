import type { HarnessV1Bootstrap } from '@ai-sdk/harness'

/** The SDK build the bootstrap installs. Bump it, then check the stream and endpoints still hold. */
export const CURSOR_SDK_VERSION = '1.0.32'

/**
 * Built-in tools the agent can use at {@link CURSOR_SDK_VERSION} without any `tool_call` in the
 * stream. Cursor's backend sends their calls, but the SDK's interaction-update converter maps
 * `webSearchToolCall`, `webFetchToolCall` and `fetchToolCall` to null and drops them, so they
 * never reach `run.stream()`, `onDelta` or `onStep`. A bump that reports them empties this.
 */
export const CURSOR_SDK_UNREPORTED_TOOLS: readonly ('webSearch' | 'webFetch')[] = [
  'webSearch',
  'webFetch',
]

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

let agent
let run
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
      const options = {
        apiKey: process.env.CURSOR_API_KEY,
        ...(turn.model ? { model: turn.model } : {}),
        local: {
          cwd: turn.cwd,
          store: new JsonlLocalAgentStore(turn.storeDir),
          settingSources: turn.settingSources,
          ...(turn.sandbox ? { sandboxOptions: { enabled: true } } : {}),
        },
        ...(turn.mcpServers ? { mcpServers: turn.mcpServers } : {}),
      }
      agent = turn.agentId ? await Agent.resume(turn.agentId, options) : await Agent.create(options)
    }
    out({ type: 'init', turn: n, agentId: agent.agentId, model: agent.model, sdkVersion: turn.sdkVersion })
    run = await agent.send(prompt)
    for await (const event of run.stream()) out({ type: 'event', event })
    const result = await run.wait()
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
