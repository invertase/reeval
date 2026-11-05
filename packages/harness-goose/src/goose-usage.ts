import { shellQuote } from '@ai-sdk/harness/utils'
import type { LanguageModelV4Usage } from '@ai-sdk/provider'
import type { Experimental_SandboxSession as SandboxSession } from '@ai-sdk/provider-utils'

/**
 * Goose's sessions database, under its home (the bootstrap's private one,
 * `~/.ai-sdk-harness/.harness-bootstrap/goose/home`).
 */
export const GOOSE_SESSIONS_DB = '.local/share/goose/sessions/sessions.db'

/**
 * One model call as Goose's `usage_ledger` keeps it: `input` is the whole prompt, cache reads
 * included, and `output` includes the thinking tokens, which it doesn't count apart.
 */
export type GooseLedgerRow = {
  id: number
  model: string | null
  input: number | null
  output: number | null
  cacheRead: number | null
  cacheWrite: number | null
  /** Goose's own estimate, in USD, from its model catalog's prices. */
  cost: number | null
  compaction: boolean
}

/**
 * Prints, as JSON, the database's last `usage_ledger` id (`max`) or every row after an id. Goose
 * writes a row when each model call ends, its subagents' and compactions' included, and keeps
 * the database open in WAL mode, which a read-only connection reads. A database Goose hasn't
 * created yet has no rows; a Node without `node:sqlite` (before 22.13) prints an error.
 */
const SCRIPT = `const [file, mode] = process.argv.slice(1)
const out = (v) => process.stdout.write(JSON.stringify(v))
try {
  if (!require('fs').existsSync(file)) out(mode === 'max' ? { max: 0 } : { rows: [] })
  else {
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(file, { readOnly: true })
    if (mode === 'max') out({ max: db.prepare('SELECT coalesce(max(id), 0) AS n FROM usage_ledger').get().n })
    else out({ rows: db.prepare('SELECT id, model, input_tokens AS input, output_tokens AS output, cache_read_tokens AS cacheRead, cache_write_tokens AS cacheWrite, cost, is_compaction AS compaction FROM usage_ledger WHERE id > ? ORDER BY id').all(Number(mode)) })
    db.close()
  }
} catch (e) {
  out({ error: String(e && e.message) })
}
`

/** The command that prints the ledger's last id (`max`), or its rows after `after`. */
export function gooseLedgerCommand(home: string, mode: 'max' | number): string {
  return ['node', '-e', SCRIPT, `${home}/${GOOSE_SESSIONS_DB}`, String(mode)]
    .map(shellQuote)
    .join(' ')
}

const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)

/** What the command printed: the last id, the rows, or undefined when it couldn't read them. */
export function parseGooseLedger(
  stdout: string,
): { max: number } | { rows: GooseLedgerRow[] } | undefined {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    return undefined
  }
  const v = (value ?? {}) as Record<string, unknown>
  if (Number.isInteger(v.max)) return { max: v.max as number }
  if (!Array.isArray(v.rows)) return undefined
  const rows: GooseLedgerRow[] = []
  for (const r of v.rows as Array<Record<string, unknown>>) {
    if (!r || !Number.isInteger(r.id)) return undefined
    rows.push({
      id: r.id as number,
      model: typeof r.model === 'string' ? r.model : null,
      input: count(r.input),
      output: count(r.output),
      cacheRead: count(r.cacheRead),
      cacheWrite: count(r.cacheWrite),
      cost: count(r.cost),
      compaction: r.compaction === 1 || r.compaction === true,
    })
  }
  return { rows }
}

/**
 * A turn's usage, summed over its ledger rows; undefined without any. Gemini reports no cache
 * writes and no cache read on a call without one, so a missing count is 0. `reasoning` stays
 * unknown: the ledger folds it into `output`. The rows go in `raw`, each call's usage.
 */
export function gooseLedgerUsage(
  rows: readonly GooseLedgerRow[],
): LanguageModelV4Usage | undefined {
  if (rows.length === 0) return undefined
  const sum = (k: 'input' | 'output' | 'cacheRead' | 'cacheWrite') =>
    rows.reduce((n, r) => n + (r[k] ?? 0), 0)
  const total = sum('input')
  const cacheRead = sum('cacheRead')
  const cacheWrite = sum('cacheWrite')
  return {
    inputTokens: {
      total,
      noCache: Math.max(total - cacheRead - cacheWrite, 0),
      cacheRead,
      cacheWrite,
    },
    outputTokens: { total: sum('output'), text: undefined, reasoning: undefined },
    raw: { usage_ledger: rows.map((r) => ({ ...r })) },
  }
}

/**
 * Reads a session's turns' usage from Goose's ledger: before a turn, the last row it has, and
 * after it, the rows the turn added. A read that fails leaves that turn's usage unknown, and the
 * next turn starts from the ledger's last row again.
 */
export class GooseLedger {
  private after: number | undefined
  private readonly sandbox: Pick<SandboxSession, 'run'>
  /** Goose's home in the sandbox. */
  private readonly home: string

  constructor(sandbox: Pick<SandboxSession, 'run'>, home: string) {
    this.sandbox = sandbox
    this.home = home
  }

  /** Marks where the next turn's rows start, unless the last turn's read already did. */
  async beforeTurn(abortSignal?: AbortSignal): Promise<void> {
    if (this.after !== undefined) return
    const read = await this.run('max', abortSignal)
    this.after = read && 'max' in read ? read.max : undefined
  }

  /** The usage of the rows the turn added; undefined when there are none or they can't be read. */
  async afterTurn(abortSignal?: AbortSignal): Promise<LanguageModelV4Usage | undefined> {
    const after = this.after
    this.after = undefined
    if (after === undefined) return undefined
    const read = await this.run(after, abortSignal)
    if (!read || !('rows' in read)) return undefined
    this.after = read.rows.at(-1)?.id ?? after
    return gooseLedgerUsage(read.rows)
  }

  private async run(mode: 'max' | number, abortSignal?: AbortSignal) {
    try {
      const r = await this.sandbox.run({
        command: gooseLedgerCommand(this.home, mode),
        ...(abortSignal ? { abortSignal } : {}),
      })
      return r.exitCode === 0 ? parseGooseLedger(r.stdout) : undefined
    } catch {
      return undefined
    }
  }
}
