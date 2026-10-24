// `reeval query`: read-only SQL over `.reeval/history.db`, the projection of every recorded and scratch run.
import { UsageError } from './errors.ts'
import type { HistoryDb, QueryResult } from './history/db.ts'
import { clip } from './text.ts'
import type { ResolvedConfig } from './types.ts'

export type QueryFlags = { json?: boolean; schema?: boolean; rebuild?: boolean; run?: string }

type Ctx = {
  config: ResolvedConfig
  flags: QueryFlags
  out: (s: string) => void
  err: (s: string) => void
}

const EXAMPLES = [
  'reeval query lift',
  `reeval query "SELECT eval_key, variant, points, lo, hi FROM lift WHERE within_noise = 0"`,
  `reeval query "SELECT * FROM failing_attempts WHERE skill = 'house-greeting' AND model LIKE 'composer%'"`,
  `reeval query "SELECT eval_key, cell_key, first_seen, flaky_runs FROM flaky_cells"`,
  `reeval query "SELECT run_id, eval_key, changed FROM drift ORDER BY run_id DESC LIMIT 20"`,
  `reeval query "SELECT eval_key, outcome FROM evals WHERE run_id = :run" --run last`,
  `reeval query "SELECT branch, outcome, COUNT(*) AS n FROM eval_trend GROUP BY branch, outcome" --json`,
]

/**
 * A text cell, clipped to 60 characters, except a `sql` column: no view or table of reeval's has
 * one, so it's `sqlite_schema.sql`, a CREATE statement only useful whole.
 */
const cell = (value: unknown, column: string) => {
  if (value === null || value === undefined) return '·'
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return column === 'sql' ? text : clip(text, 60)
}

const width = (text: string) => Math.max(...text.split('\n').map((line) => line.length))

/** Rows as an aligned table: a header, then one line per row. */
export function formatRows({ columns, rows }: QueryResult): string {
  if (rows.length === 0) return '(no rows)'
  const table = [columns, ...rows.map((r) => columns.map((c) => cell(r[c], c)))]
  const widths = columns.map((_, i) => Math.max(...table.map((r) => width(r[i] ?? ''))))
  return table
    .map((r) =>
      r
        .map((v, i) => (i === r.length - 1 ? v : v.padEnd(widths[i] ?? 0)))
        .join('  ')
        .trimEnd(),
    )
    .join('\n')
}

function formatSchema(
  schema: Array<{ name: string; type: 'table' | 'view'; columns: string[] }>,
  withExamples: boolean,
): string {
  const block = (type: 'table' | 'view', title: string) => [
    title,
    ...schema.filter((o) => o.type === type).map((o) => `  ${o.name}(${o.columns.join(', ')})`),
  ]
  return [
    ...block('view', 'Views (the common questions; filter them with SQL):'),
    '',
    ...block('table', 'Tables:'),
    ...(withExamples ? ['', 'Examples:', ...EXAMPLES.map((e) => `  ${e}`)] : []),
  ].join('\n')
}

/**
 * Whether `sql` holds more than one statement: SQLite would run the first and ignore the rest.
 * Semicolons inside quotes, identifiers and comments don't count; a trailing one is fine.
 */
export function statementCount(sql: string): number {
  let count = 0
  let pending = false
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i] as string
    if (c === "'" || c === '"' || c === '`') {
      const end = sql.indexOf(c, i + 1)
      i = end === -1 ? sql.length : end
      pending = true
    } else if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i)
      i = end === -1 ? sql.length : end
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      i = end === -1 ? sql.length : end + 1
    } else if (c === ';') {
      if (pending) count++
      pending = false
    } else if (!/\s/.test(c)) pending = true
  }
  return count + (pending ? 1 : 0)
}

/** Whether `sql` names the `:run` parameter (or `$run`, `@run`) outside quotes and comments. */
export function usesRunParameter(sql: string): boolean {
  let code = ''
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i] as string
    let end = -1
    if (c === "'" || c === '"' || c === '`') end = sql.indexOf(c, i + 1)
    else if (c === '-' && sql[i + 1] === '-') end = sql.indexOf('\n', i)
    else if (c === '/' && sql[i + 1] === '*') end = sql.indexOf('*/', i + 2) + 1
    else {
      code += c
      continue
    }
    code += ' '
    i = end <= 0 ? sql.length : end
  }
  return /[:$@]run\b/.test(code)
}

/** The run id `ref` names in history.db: `last` (or `latest`) by started_at, an id or a unique prefix. */
function resolveRunRef(db: HistoryDb, ref: string): string {
  if (ref === 'last' || ref === 'latest') {
    const [row] = db.query(
      'SELECT run_id FROM runs ORDER BY started_at DESC, run_id DESC LIMIT 1',
    ).rows
    if (!row) throw new UsageError(`reeval query --run ${ref}: .reeval/history.db has no runs yet.`)
    return String(row.run_id)
  }
  const ids = db
    .query('SELECT run_id FROM runs WHERE substr(run_id, 1, length(?)) = ? ORDER BY run_id', [
      ref,
      ref,
    ])
    .rows.map((r) => String(r.run_id))
  if (ids.includes(ref)) return ref
  if (ids.length === 1) return ids[0] as string
  throw new UsageError(
    ids.length > 1
      ? `reeval query --run ${ref}: "${ref}" matches ${ids.length} runs; use more of the id.`
      : `reeval query --run ${ref}: no run "${ref}" in .reeval/history.db. Pass last, or a run id from reeval query "SELECT run_id, started_at FROM runs ORDER BY started_at DESC".`,
  )
}

/**
 * `reeval query [sql | view] [--run <id|last>] [--json] [--schema] [--rebuild]`. With no statement
 * it lists the views and tables; a bare name selects everything from that view or table (with
 * `--run`, that run's rows). `--run` binds `:run` in a statement and never rewrites it.
 */
export async function queryCommand(ctx: Ctx, args: string[]): Promise<number> {
  const { openHistoryDb } = await import('./history/db.ts')
  const db = await openHistoryDb(ctx.config.root, ctx.config.history.dir, {
    rebuild: !!ctx.flags.rebuild,
  })
  try {
    const { sync } = db
    ctx.err(
      `history.db: ${sync.runs} runs${sync.rebuilt ? ', rebuilt' : ''}${sync.added ? `, ${sync.added} read` : ''}${sync.removed ? `, ${sync.removed} removed` : ''}`,
    )
    const text = args.join(' ').trim()
    const schema = db.schema()
    if (!text || ctx.flags.schema) {
      ctx.out(ctx.flags.json ? JSON.stringify(schema, null, 2) : formatSchema(schema, !text))
      return 0
    }
    let sql = text
    if (statementCount(text) > 1) {
      throw new UsageError(
        'reeval query runs one statement at a time; drop the extra ones after ";".',
      )
    }
    const run = ctx.flags.run
    if (/^[A-Za-z_]\w*$/.test(text)) {
      const object = schema.find((o) => o.name === text)
      if (!object) {
        const names = (type: 'view' | 'table') =>
          schema
            .filter((o) => o.type === type)
            .map((o) => o.name)
            .join(', ')
        throw new UsageError(
          `reeval query: no view or table named "${text}". Views: ${names('view')}. Tables: ${names('table')}. Run reeval query --schema for every column.`,
        )
      }
      if (run !== undefined && !object.columns.includes('run_id')) {
        throw new UsageError(
          `reeval query ${text} --run: ${text} has no run_id column (it pools runs), so --run can't filter it.`,
        )
      }
      sql = `SELECT * FROM "${text}"${run === undefined ? '' : ' WHERE run_id = :run'}`
    } else if (run === undefined && usesRunParameter(sql)) {
      throw new UsageError(
        'reeval query: the statement uses :run but no --run was given: pass --run <id|last>.',
      )
    } else if (run !== undefined && !usesRunParameter(sql)) {
      throw new UsageError(
        `reeval query --run ${run}: --run binds :run, which the statement doesn't use; add WHERE run_id = :run.`,
      )
    }
    const result =
      run === undefined ? db.query(sql) : db.query(sql, { run: resolveRunRef(db, run) })
    ctx.out(ctx.flags.json ? JSON.stringify(result.rows, null, 2) : formatRows(result))
    return 0
  } finally {
    db.close()
  }
}
