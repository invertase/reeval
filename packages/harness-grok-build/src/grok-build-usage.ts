import { shellQuote } from '@ai-sdk/harness/utils'
import { grokTurnUsage } from './grok-build-stream.ts'

/** Grok's logs, relative to `$HOME`, under the private home its bootstrap gives it. */
export const GROK_LOGS_DIR = '.ai-sdk-harness/.harness-bootstrap/grok-build/home/.grok/logs'

/**
 * Prints the counts of each model call logged since `since` (ms since the epoch) as one JSON
 * array: the `ctx` of every `shell.turn.inference_done` line in Grok's `unified*.jsonl` logs,
 * which it writes as each call finishes (its `usage.json` has only finished turns).
 * `prompt_tokens` counts the cached ones and `completion_tokens` the reasoning ones. A missing
 * log prints `[]`.
 */
const SCRIPT = `const fs = require('fs'), path = require('path')
const [rel, since] = process.argv.slice(1)
const dir = path.join(require('os').homedir(), rel)
const calls = []
let files = []
try { files = fs.readdirSync(dir).filter((f) => /^unified.*\\.jsonl$/.test(f)) } catch {}
for (const f of files) {
  for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\\n')) {
    let r
    try { r = JSON.parse(line) } catch { continue }
    if (r && r.msg === 'shell.turn.inference_done' && r.ctx && Date.parse(r.ts) >= Number(since)) calls.push(r.ctx)
  }
}
process.stdout.write(JSON.stringify(calls))
`

/** The command that prints the counts of Grok's model calls since `since`. */
export function grokStoredUsageCommand(o: { since: number }): string {
  return ['node', '-e', SCRIPT, GROK_LOGS_DIR, String(o.since)].map(shellQuote).join(' ')
}

const num = (value: unknown) => (typeof value === 'number' ? value : 0)

/** The calls the command printed, summed in the AI SDK's shape; undefined when it found none. */
export function parseGrokStoredUsage(stdout: string) {
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
  const sum = (key: string) => calls.reduce((n, c) => n + num(c[key]), 0)
  const input = sum('prompt_tokens')
  const output = sum('completion_tokens')
  const usage = grokTurnUsage({
    inputTokens: input,
    outputTokens: output,
    cachedReadTokens: sum('cached_prompt_tokens'),
    reasoningTokens: sum('reasoning_tokens'),
    totalTokens: input + output,
  })
  return usage && { usage, calls: calls.length }
}
