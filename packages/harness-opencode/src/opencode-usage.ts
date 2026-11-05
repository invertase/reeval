import { shellQuote } from '@ai-sdk/harness/utils'

/** OpenCode's database, relative to `$HOME`: its sessions, messages and parts. */
export const OPENCODE_DB = '.local/share/opencode/opencode.db'

/**
 * Prints the `tokens` of each assistant message created since `since` (ms since the epoch) as one
 * JSON array. OpenCode stores a message, one per model call, once its call finishes: `input` is
 * the uncached input and `reasoning` is apart from `output`. A Node without `node:sqlite` (before
 * 22.13), or a missing database, prints `[]`.
 */
const SCRIPT = `const [file, since] = process.argv.slice(1)
const calls = []
try {
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(require('path').join(require('os').homedir(), file), { readOnly: true })
  for (const row of db.prepare("SELECT data FROM session_message WHERE type = 'assistant' AND time_created >= ? ORDER BY seq").all(Number(since))) {
    try { const t = JSON.parse(row.data).tokens; if (t) calls.push(t) } catch {}
  }
  db.close()
} catch {}
process.stdout.write(JSON.stringify(calls))
`

/** The command that prints the tokens of OpenCode's model calls since `since`. */
export function openCodeStoredUsageCommand(o: { since: number }): string {
  return ['node', '-e', SCRIPT, OPENCODE_DB, String(o.since)].map(shellQuote).join(' ')
}

const num = (value: unknown) => (typeof value === 'number' ? value : 0)

/** The calls the command printed, summed in the AI SDK's shape; undefined when it found none. */
export function parseOpenCodeStoredUsage(stdout: string) {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    return undefined
  }
  if (!Array.isArray(value)) return undefined
  const calls = value.filter(
    (c): c is Record<string, unknown> => typeof c === 'object' && c !== null,
  )
  if (!calls.length) return undefined
  let input = 0
  let cacheRead = 0
  let cacheWrite = 0
  let output = 0
  let reasoning = 0
  for (const call of calls) {
    const cache = (typeof call.cache === 'object' && call.cache) || {}
    input += num(call.input)
    cacheRead += num((cache as Record<string, unknown>).read)
    cacheWrite += num((cache as Record<string, unknown>).write)
    output += num(call.output)
    reasoning += num(call.reasoning)
  }
  return {
    usage: {
      inputTokens: { total: input + cacheRead + cacheWrite, noCache: input, cacheRead, cacheWrite },
      outputTokens: { total: output + reasoning, text: output, reasoning },
    },
    calls: calls.length,
  }
}
