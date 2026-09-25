// `es query`: read-only SQL over `.es/history.db`, the projection of every recorded and scratch run.
import { UsageError } from './errors.ts'
import type { QueryResult } from './history/db.ts'
import { clip } from './text.ts'
import type { ResolvedConfig } from './types.ts'

export type QueryFlags = { json?: boolean; schema?: boolean; rebuild?: boolean }

type Ctx = {
  config: ResolvedConfig
  flags: QueryFlags
  out: (s: string) => void
  err: (s: string) => void
}

const EXAMPLES = [
  'es query lift',
  `es query "SELECT eval_key, variant, points, lo, hi FROM lift WHERE within_noise = 0"`,
  `es query "SELECT * FROM failing_attempts WHERE skill = 'house-greeting' AND model LIKE 'composer%'"`,
  `es query "SELECT eval_key, cell_key, first_seen, flaky_runs FROM flaky_cells"`,
  `es query "SELECT run_id, eval_key, changed FROM drift ORDER BY run_id DESC LIMIT 20"`,
  `es query "SELECT branch, outcome, COUNT(*) AS n FROM eval_trend GROUP BY branch, outcome" --json`,
]

const cell = (value: unknown) =>
  value === null || value === undefined
    ? '·'
    : clip(typeof value === 'object' ? JSON.stringify(value) : String(value), 60)

/** Rows as an aligned table: a header, then one line per row. */
export function formatRows({ columns, rows }: QueryResult): string {
  if (rows.length === 0) return '(no rows)'
  const table = [columns, ...rows.map((r) => columns.map((c) => cell(r[c])))]
  const widths = columns.map((_, i) => Math.max(...table.map((r) => (r[i] ?? '').length)))
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

/**
 * `es query [sql | view] [--json] [--schema] [--rebuild]`. With no statement it lists the views
 * and tables; a bare name selects everything from that view or table.
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
      throw new UsageError('es query runs one statement at a time; drop the extra ones after ";".')
    }
    if (/^[A-Za-z_]\w*$/.test(text)) {
      if (!schema.some((o) => o.name === text)) {
        throw new UsageError(
          `es query: no view or table named "${text}". Views: ${schema
            .filter((o) => o.type === 'view')
            .map((o) => o.name)
            .join(', ')}. Run es query --schema for every column.`,
        )
      }
      sql = `SELECT * FROM "${text}"`
    }
    const result = db.query(sql)
    ctx.out(ctx.flags.json ? JSON.stringify(result.rows, null, 2) : formatRows(result))
    return 0
  } finally {
    db.close()
  }
}
