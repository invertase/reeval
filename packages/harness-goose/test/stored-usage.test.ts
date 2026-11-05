import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { GOOSE_HOME } from '../src/goose-launcher.ts'
import {
  GOOSE_SESSIONS_DB,
  gooseLedgerUsage,
  gooseStoredUsageCommand,
  gooseUsageMark,
  parseGooseStoredUsage,
} from '../src/goose-usage.ts'

type Row = Record<string, number | string | null>
/** Goose 1.56.0's `usage_ledger`, captured from a two-turn attempt, with each turn's wire totals. */
const captured = JSON.parse(
  readFileSync(new URL('./fixtures/usage-ledger.json', import.meta.url), 'utf8'),
) as {
  schema: string
  rows: Row[]
  turns: Array<{ wire: { input: number; cacheRead: number; output: number } }>
}

const home = mkdtempSync(join(tmpdir(), 'goose-stored-'))
const file = join(home, GOOSE_HOME, GOOSE_SESSIONS_DB)
mkdirSync(dirname(file), { recursive: true })
const db = new DatabaseSync(file)
db.exec('PRAGMA foreign_keys=OFF')
db.exec(captured.schema)
for (const r of captured.rows) {
  const cols = Object.keys(r)
  db.prepare(
    `INSERT INTO usage_ledger (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
  ).run(...cols.map((c) => r[c] ?? null))
}
db.close()

const read = (o: { mark?: string }, at = home) =>
  spawnSync('bash', ['-c', gooseStoredUsageCommand(o)], {
    env: { ...process.env, HOME: at },
    encoding: 'utf8',
  })

test("a cut-off turn's stored usage is the rows after the last turn's reported ones", () => {
  // The usage the adapter reported for the first turn, rows 1 to 7.
  const firstTurn = gooseLedgerUsage(captured.rows.slice(0, 7).map(toRow))
  const mark = gooseUsageMark(firstTurn?.raw)
  assert.equal(mark, '7')
  const out = read(mark ? { mark } : {})
  assert.equal(out.status, 0, out.stderr)
  const stored = parseGooseStoredUsage(out.stdout)
  const wire = captured.turns[1]?.wire
  assert.equal(stored?.calls, 7)
  assert.equal(stored?.mark, '14')
  assert.equal(stored?.usage.inputTokens.noCache, wire?.input)
  assert.equal(stored?.usage.inputTokens.cacheRead, wire?.cacheRead)
  assert.equal(stored?.usage.outputTokens.total, wire?.output)
})

test('twin: without a mark it reads every row, the earlier turn too', () => {
  assert.equal(parseGooseStoredUsage(read({}).stdout)?.calls, 14)
})

test('no rows after the mark, or no database, is no stored usage', () => {
  assert.equal(parseGooseStoredUsage(read({ mark: '14' }).stdout), undefined)
  const empty = read({}, mkdtempSync(join(tmpdir(), 'goose-stored-')))
  assert.equal(empty.status, 0, empty.stderr)
  assert.equal(parseGooseStoredUsage(empty.stdout), undefined)
  assert.equal(gooseUsageMark(undefined), undefined)
  assert.equal(gooseUsageMark({ usage_ledger: [] }), undefined)
})

function toRow(r: Row) {
  return {
    id: r.id as number,
    model: r.model as string,
    input: r.input_tokens as number,
    output: r.output_tokens as number,
    cacheRead: r.cache_read_tokens as number | null,
    cacheWrite: r.cache_write_tokens as number | null,
    cost: r.cost as number | null,
    compaction: false,
  }
}
