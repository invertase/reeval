import { posix } from 'node:path'
import { shellQuote } from '@ai-sdk/harness/utils'
import type { Experimental_SandboxSession as SandboxSession } from '@ai-sdk/provider-utils'

/** The CLI's own data directory, relative to `$HOME`: its conversations, logs and settings. */
export const ANTIGRAVITY_DATA_DIR = '.gemini/antigravity-cli'

/**
 * One model step's thought summary, as agy stored it: Gemini sends it (`thought: true` parts) and
 * agy keeps it, but its stream-json leaves it out.
 */
export type AntigravityThought = {
  /** The step index, the same as the stream's `step_update.step_index`. */
  step: number
  text: string
  /** The step's `thinking_duration`, from the conversation's database; null where it's unknown. */
  durationMs: number | null
}

/**
 * Reads the stored thoughts of a conversation's steps from `fromStep` on, in the sandbox, and
 * prints them as one JSON array. The text is each `PLANNER_RESPONSE` line's `thinking` in
 * `brain/<id>/.system_generated/logs/transcript_full.jsonl`. Its time is only in
 * `conversations/<id>.db`, an SQLite table of protobuf steps: the step's planner response (field
 * 20) has `thinking_duration` (field 11, a `google.protobuf.Duration`). A Node without
 * `node:sqlite` (before 22.13) leaves every duration null; a missing store prints `[]`.
 */
const SCRIPT = `const fs = require('fs')
const [dir, id, from] = process.argv.slice(1)
const thoughts = new Map()
try {
  const file = dir + '/brain/' + id + '/.system_generated/logs/transcript_full.jsonl'
  for (const line of fs.readFileSync(file, 'utf8').split('\\n')) {
    let s
    try { s = JSON.parse(line) } catch { continue }
    if (Number.isInteger(s.step_index) && s.step_index >= Number(from) && typeof s.thinking === 'string' && s.thinking.trim())
      thoughts.set(s.step_index, { step: s.step_index, text: s.thinking, durationMs: null })
  }
} catch {}
function varint(b, i) {
  let n = 0, shift = 1
  for (;;) { const c = b[i++]; n += (c & 127) * shift; shift *= 128; if (c < 128) return [n, i] }
}
function field(b, want) {
  let i = 0
  while (i < b.length) {
    let key; [key, i] = varint(b, i)
    const f = Math.floor(key / 8), w = key & 7
    if (w === 0) { let v; [v, i] = varint(b, i); if (f === want) return v }
    else if (w === 1) i += 8
    else if (w === 5) i += 4
    else if (w === 2) { let n; [n, i] = varint(b, i); if (f === want) return b.subarray(i, i + n); i += n }
    else return undefined
  }
  return undefined
}
try {
  if (thoughts.size) {
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(dir + '/conversations/' + id + '.db', { readOnly: true })
    for (const row of db.prepare('SELECT idx, step_payload FROM steps WHERE idx >= ?').all(Number(from))) {
      const t = thoughts.get(row.idx)
      const planner = t && row.step_payload && field(row.step_payload, 20)
      const d = planner instanceof Uint8Array ? field(planner, 11) : undefined
      if (!(d instanceof Uint8Array)) continue
      t.durationMs = Math.round((field(d, 1) ?? 0) * 1000 + (field(d, 2) ?? 0) / 1e6)
    }
    db.close()
  }
} catch {}
process.stdout.write(JSON.stringify([...thoughts.values()]))
`

/** The command that prints a conversation's stored thoughts, from `fromStep` on. */
export function antigravityThoughtsCommand(o: {
  home: string
  conversationId: string
  fromStep: number
}): string {
  const dir = posix.join(o.home, ANTIGRAVITY_DATA_DIR)
  return ['node', '-e', SCRIPT, dir, o.conversationId, String(o.fromStep)].map(shellQuote).join(' ')
}

/** The thoughts the command printed; anything it couldn't read is left out. */
export function parseAntigravityThoughts(stdout: string): AntigravityThought[] {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    return []
  }
  if (!Array.isArray(value)) return []
  return value.flatMap((t) =>
    t &&
    typeof t === 'object' &&
    Number.isInteger(t.step) &&
    typeof t.text === 'string' &&
    (t.durationMs === null || typeof t.durationMs === 'number')
      ? [{ step: t.step, text: t.text, durationMs: t.durationMs }]
      : [],
  )
}

/**
 * A finished turn's thoughts, read back from the CLI's stored conversation. A store that's
 * missing or unreadable, or a sandbox with no Node, gives none: the turn stands without them.
 */
export async function readAntigravityThoughts(
  sandbox: Pick<SandboxSession, 'run'>,
  o: { home: string; conversationId: string; fromStep: number; abortSignal?: AbortSignal },
): Promise<AntigravityThought[]> {
  try {
    const { exitCode, stdout } = await sandbox.run({
      command: antigravityThoughtsCommand(o),
      ...(o.abortSignal ? { abortSignal: o.abortSignal } : {}),
    })
    return exitCode === 0 ? parseAntigravityThoughts(stdout) : []
  } catch {
    return []
  }
}
