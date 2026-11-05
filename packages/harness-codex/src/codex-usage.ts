import { posix } from 'node:path'
import { shellQuote } from '@ai-sdk/harness/utils'
import { CODEX_HOME_DIR } from './codex-harness.ts'
import { type CodexUsage, toUsage } from './codex-stream.ts'

/**
 * Prints each model call's counts since `since` (ms since the epoch) as one JSON array: the
 * `last_token_usage` of every `token_count` event in Codex's rollouts
 * (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`), which Codex writes as each call finishes.
 * A missing store prints `[]`.
 */
const SCRIPT = `const fs = require('fs'), path = require('path')
const [dir, since] = process.argv.slice(1)
const calls = []
const walk = (d) => {
  let entries = []
  try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch {}
  for (const e of entries) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (/^rollout-.*\\.jsonl$/.test(e.name)) {
      for (const line of fs.readFileSync(p, 'utf8').split('\\n')) {
        let r
        try { r = JSON.parse(line) } catch { continue }
        const u = r && r.type === 'event_msg' && r.payload && r.payload.type === 'token_count' && r.payload.info && r.payload.info.last_token_usage
        if (u && Date.parse(r.timestamp) >= Number(since)) calls.push(u)
      }
    }
  }
}
walk(path.join(require('os').homedir(), dir))
process.stdout.write(JSON.stringify(calls))
`

/** The command that prints the counts of Codex's model calls since `since`. */
export function codexStoredUsageCommand(o: { since: number }): string {
  return ['node', '-e', SCRIPT, posix.join(CODEX_HOME_DIR, 'sessions'), String(o.since)]
    .map(shellQuote)
    .join(' ')
}

const KEYS = [
  'input_tokens',
  'cached_input_tokens',
  'cache_write_input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
] as const

/** The calls the command printed, summed in the AI SDK's shape; undefined when it found none. */
export function parseCodexStoredUsage(stdout: string) {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    return undefined
  }
  if (!Array.isArray(value)) return undefined
  const calls = value.filter((c): c is CodexUsage => typeof c === 'object' && c !== null)
  if (!calls.length) return undefined
  const sum: CodexUsage = {}
  for (const call of calls) {
    for (const key of KEYS) {
      const n = call[key]
      if (typeof n === 'number') sum[key] = (sum[key] ?? 0) + n
    }
  }
  return { usage: toUsage(sum), calls: calls.length }
}
