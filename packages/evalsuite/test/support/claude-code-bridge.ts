// Runs a Claude Code bridge (the bridge.mjs @ai-sdk/harness-claude-code's bootstrap writes into the
// sandbox) on the host, key-free: a stub Agent SDK replays a turn's captured SDK messages to it, and
// the host side of the bridge protocol sends the captured `start` and collects the parts it emits.
// test/replay.test.ts runs the bridge ES ships; scripts/drift/claude-code-patch.mjs runs the newest
// upstream one.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import WebSocket from 'ws'

export type BridgePart = { type: string; [key: string]: unknown }

const require = createRequire(import.meta.url)
const packageDir = (name: string) => dirname(require.resolve(`${name}/package.json`))

/** The only SDK export the bridge calls: `query`, here a replay of the captured messages. */
const STUB_SDK = `import { readFileSync } from 'node:fs'
export function query({ prompt }) {
  const messages = readFileSync(process.env.ES_REPLAY_SDK_MESSAGES, 'utf8')
    .split('\\n').filter(Boolean).map((line) => JSON.parse(line))
  async function* replay() {
    await prompt[Symbol.asyncIterator]().next()
    yield* messages
  }
  return Object.assign(replay(), { interrupt: async () => {} })
}
`

/** The bridge's parts for one turn of `messages`, started with `start`, up to `finish` or `error`. */
export async function replayBridge(options: {
  bridge: string
  start: Record<string, unknown>
  messages: string
  timeoutMs?: number
}): Promise<BridgePart[]> {
  const dir = mkdtempSync(join(tmpdir(), 'es-claude-bridge-'))
  try {
    const modules = join(dir, 'node_modules')
    const sdk = join(modules, '@anthropic-ai/claude-agent-sdk')
    const mcp = join(modules, '@modelcontextprotocol/sdk/server')
    mkdirSync(sdk, { recursive: true })
    mkdirSync(mcp, { recursive: true })
    writeFileSync(join(sdk, 'package.json'), '{"type":"module","main":"index.js"}')
    writeFileSync(join(sdk, 'index.js'), STUB_SDK)
    writeFileSync(join(mcp, '../package.json'), '{"type":"module"}')
    writeFileSync(join(mcp, 'mcp.js'), 'export class McpServer {}\n')
    for (const name of ['ws', 'zod']) symlinkSync(packageDir(name), join(modules, name))
    writeFileSync(join(dir, 'bridge.mjs'), readFileSync(options.bridge))
    const messages = join(dir, 'messages.jsonl')
    writeFileSync(messages, options.messages)
    mkdirSync(join(dir, 'work'))

    const token = 'replay-token'
    const child = spawn(
      process.execPath,
      ['bridge.mjs', '--workdir', join(dir, 'work'), '--bridge-state-dir', join(dir, 'state')],
      {
        cwd: dir,
        env: {
          PATH: process.env.PATH,
          BRIDGE_CHANNEL_TOKEN: token,
          BRIDGE_WS_PORT: '0',
          ES_REPLAY_SDK_MESSAGES: messages,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let stderr = ''
    child.stderr.on('data', (d) => {
      stderr += d
    })
    try {
      return await new Promise<BridgePart[]>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`the bridge didn't finish the turn:\n${stderr}`)),
          options.timeoutMs ?? 20_000,
        )
        const fail = (e: Error) => {
          clearTimeout(timer)
          reject(e)
        }
        child.on('exit', (code) => fail(new Error(`the bridge exited (${code}):\n${stderr}`)))
        createInterface({ input: child.stdout }).on('line', (line) => {
          const ready = (() => {
            try {
              return JSON.parse(line) as { type?: string; port?: number; message?: string }
            } catch {
              return {}
            }
          })()
          if (ready.type === 'bridge-fatal') fail(new Error(`bridge-fatal: ${ready.message}`))
          if (ready.type !== 'bridge-ready') return
          const ws = new WebSocket(`ws://127.0.0.1:${ready.port}/?agent_bridge_token=${token}`)
          const parts: BridgePart[] = []
          ws.on('error', fail)
          ws.on('message', (data) => {
            const part = JSON.parse(String(data)) as BridgePart
            if (part.type === 'bridge-hello') {
              ws.send(JSON.stringify({ ...options.start, type: 'start' }))
              return
            }
            if (typeof part.seq !== 'number') return
            const { seq: _, ...rest } = part
            parts.push(rest)
            if (part.type === 'finish' || part.type === 'error') {
              clearTimeout(timer)
              ws.close()
              resolve(parts)
            }
          })
        })
      })
    } finally {
      child.kill('SIGKILL')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
