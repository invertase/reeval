import { readFile } from 'node:fs/promises'
import { MCP_TIMER } from '@reeval/sandbox-docker'
import { shellQuote } from '@reeval/sandbox-docker/process'
import type { ResolvedMcpServer } from '../environment/resolve.ts'
import { InfraError, type Sandbox } from '../sandbox/types.ts'
import type { McpStartup } from '../types.ts'

/**
 * The timer and its log beside the workspace: `/reeval/bin/mcp-timer.cjs` in Docker. `.cjs`, since
 * a sandbox's directories may be in a `"type": "module"` package.
 */
const TIMER = '../bin/mcp-timer.cjs'
const LOG = '../mcp-startup.jsonl'

/** How long the timer waits for a server's `initialize` answer; fixed in the shim. */
export const MCP_STARTUP_TIMEOUT_S = 60

/** One line of the timer's log. */
type LogEntry = {
  server: string
  spawnedAt: number
  initializedAt?: number
  timeout?: true
  exitCode?: number | null
}

/** The attempt's error when an MCP server never answered `initialize`. */
export const mcpTimeoutMessage = (server: string) =>
  `MCP server ${server} didn't answer initialize within ${MCP_STARTUP_TIMEOUT_S}s`

/** Reads the timer's log as it grows: each call returns the entries written since the last. */
export type McpStartupLog = {
  read(): Promise<LogEntry[]>
}

/**
 * Puts the timer in the sandbox and runs every stdio server through it, so whichever process
 * starts a server (the agent's CLI, once a session or once a turn, or the fake agent) logs when it
 * answered. Returns the servers unchanged, and no log, when none is stdio.
 */
export async function timeMcpServers(
  box: Sandbox,
  servers: Record<string, ResolvedMcpServer>,
  signal: AbortSignal,
): Promise<{ servers: Record<string, ResolvedMcpServer>; log?: McpStartupLog }> {
  if (!Object.values(servers).some((s) => s.transport === 'stdio')) return { servers }
  await box.writeFile(TIMER, await readFile(MCP_TIMER, 'utf8'))
  await box.writeFile(LOG, '')
  const timer = `${box.workdir.replace(/[\\/][^\\/]*$/, '')}/bin/mcp-timer.cjs`
  const r = await box.exec(`chmod +x ${shellQuote(timer)}`, { signal })
  if (r.exitCode !== 0) {
    throw new InfraError(`Couldn't install reeval's MCP timer at ${timer}: ${r.stderr.trim()}`)
  }
  const wrapped = Object.fromEntries(
    Object.entries(servers).map(([name, s]): [string, ResolvedMcpServer] => [
      name,
      s.transport === 'stdio'
        ? { ...s, command: timer, args: ['--name', name, '--', s.command, ...s.args] }
        : s,
    ]),
  )
  let seen = 0
  const log: McpStartupLog = {
    async read() {
      const lines = ((await box.readFile(LOG).catch(() => null)) ?? '').split('\n')
      // The last line is complete only once its newline is written.
      const complete = lines.slice(0, -1)
      const fresh = complete.slice(seen)
      seen = complete.length
      return fresh.flatMap((line) => {
        try {
          const entry = JSON.parse(line) as LogEntry
          return typeof entry.server === 'string' ? [entry] : []
        } catch {
          return []
        }
      })
    },
  }
  return { servers: wrapped, log }
}

/** Each server start in `entries`, with how long it took to answer `initialize`; null when it didn't. */
export const mcpStartupOf = (entries: LogEntry[]): McpStartup[] =>
  entries.map((e) => ({
    server: e.server,
    ms: e.initializedAt === undefined ? null : Math.max(0, e.initializedAt - e.spawnedAt),
  }))

/** The first server in `entries` that never answered `initialize`. */
export const timedOutServer = (entries: LogEntry[]): string | undefined =>
  entries.find((e) => e.timeout)?.server
