import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { translated } from '../src/goose-harness.ts'
import {
  GOOSE_SESSIONS_DB,
  GooseLedger,
  gooseLedgerUsage,
  parseGooseLedger,
} from '../src/goose-usage.ts'

type Row = Record<string, number | string | null>
/** Goose 1.56.0's `usage_ledger`, captured from a two-turn attempt, with each turn's wire totals. */
const captured = JSON.parse(
  readFileSync(new URL('./fixtures/usage-ledger.json', import.meta.url), 'utf8'),
) as {
  schema: string
  rows: Row[]
  turns: Array<{
    rows: [number, number]
    wire: { input: number; cacheRead: number; output: number }
  }>
}

/** A Goose home with its sessions database in WAL mode, held open as Goose holds it. */
function gooseHome() {
  const home = mkdtempSync(join(tmpdir(), 'goose-home-'))
  const file = join(home, GOOSE_SESSIONS_DB)
  mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('PRAGMA foreign_keys=OFF')
  db.exec(captured.schema)
  const insert = (rows: Row[]) => {
    for (const r of rows) {
      const cols = Object.keys(r)
      db.prepare(
        `INSERT INTO usage_ledger (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      ).run(...cols.map((c) => r[c] ?? null))
    }
  }
  return { home, file, db, insert }
}

/** The sandbox's `run`, here: the command in bash on this machine. */
const runs: string[] = []
const local = {
  run: async ({ command }: { command: string }) => {
    runs.push(command)
    const r = spawnSync('bash', ['-c', command], { encoding: 'utf8' })
    return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }
  },
} as never

const rowsOf = ([from, to]: [number, number]) =>
  captured.rows.filter((r) => (r.id as number) >= from && (r.id as number) <= to)
const recorded = (usage: ReturnType<typeof gooseLedgerUsage>) => ({
  input: usage?.inputTokens.noCache,
  cacheRead: usage?.inputTokens.cacheRead,
  output: usage?.outputTokens.total,
})

test("each turn's usage is the rows it added to the ledger, equal to the wire's", async () => {
  const { home, insert, db } = gooseHome()
  const ledger = new GooseLedger(local, home)
  for (const turn of captured.turns) {
    await ledger.beforeTurn()
    insert(rowsOf(turn.rows))
    const usage = await ledger.afterTurn()
    assert.deepEqual(recorded(usage), turn.wire)
    assert.equal(
      usage?.inputTokens.total,
      turn.wire.input + turn.wire.cacheRead,
      'the prompt, cache reads included',
    )
    assert.equal(usage?.inputTokens.cacheWrite, 0)
    // The ledger folds the thinking tokens into the output; their share is unknown, not 0.
    assert.equal(usage?.outputTokens.reasoning, undefined)
    assert.deepEqual(
      ((usage?.raw?.usage_ledger ?? []) as Array<{ id: number }>).map((r) => r.id),
      rowsOf(turn.rows).map((r) => r.id),
    )
  }
  db.close()
})

test('twin: the ledger read whole would count the first turn into the second', async () => {
  const { home, insert, db } = gooseHome()
  insert(rowsOf(captured.turns[0]?.rows as [number, number]))
  const ledger = new GooseLedger(local, home)
  await ledger.beforeTurn()
  insert(rowsOf(captured.turns[1]?.rows as [number, number]))
  assert.deepEqual(recorded(await ledger.afterTurn()), captured.turns[1]?.wire)
  const whole = parseGooseLedger(JSON.stringify({ rows: captured.rows.map(asRead) }))
  assert.ok(whole && 'rows' in whole)
  assert.notDeepEqual(recorded(gooseLedgerUsage(whole.rows)), captured.turns[1]?.wire)
  db.close()
})

/** A captured row as the script prints it. */
function asRead(r: Row) {
  return {
    id: r.id,
    model: r.model,
    input: r.input_tokens,
    output: r.output_tokens,
    cacheRead: r.cache_read_tokens,
    cacheWrite: r.cache_write_tokens,
    cost: r.cost,
    compaction: r.is_compaction,
  }
}

test('a turn with no new rows, or before Goose made its database, has no usage', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'goose-home-'))
  const ledger = new GooseLedger(local, empty)
  await ledger.beforeTurn()
  assert.equal(await ledger.afterTurn(), undefined)
  const { home, db } = gooseHome()
  const again = new GooseLedger(local, home)
  await again.beforeTurn()
  assert.equal(await again.afterTurn(), undefined)
  db.close()
})

test('a ledger it cannot read leaves the turn unknown, and the next turn starts after it', async () => {
  const { home, file, insert, db } = gooseHome()
  const ledger = new GooseLedger(local, home)
  await ledger.beforeTurn()
  insert(rowsOf(captured.turns[0]?.rows as [number, number]))
  db.close()
  const real = readFileSync(file)
  writeFileSync(file, 'not a database')
  assert.equal(await ledger.afterTurn(), undefined)
  writeFileSync(file, real)
  const reopened = new DatabaseSync(file)
  reopened.exec('PRAGMA foreign_keys=OFF')
  await ledger.beforeTurn()
  for (const r of rowsOf(captured.turns[1]?.rows as [number, number])) {
    const cols = Object.keys(r)
    reopened
      .prepare(
        `INSERT INTO usage_ledger (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      )
      .run(...cols.map((c) => r[c] ?? null))
  }
  assert.deepEqual(recorded(await ledger.afterTurn()), captured.turns[1]?.wire)
  reopened.close()
})

test('parses only what the script prints: an error or a malformed row is unreadable', () => {
  assert.deepEqual(parseGooseLedger('{"max":3}'), { max: 3 })
  assert.equal(parseGooseLedger('{"error":"no such table: usage_ledger"}'), undefined)
  assert.equal(parseGooseLedger('{"rows":[{"id":"1"}]}'), undefined)
  assert.equal(parseGooseLedger('node: bad option'), undefined)
  assert.deepEqual(parseGooseLedger('{"rows":[{"id":1,"input":5,"output":-1,"compaction":1}]}'), {
    rows: [
      {
        id: 1,
        model: null,
        input: 5,
        output: null,
        cacheRead: null,
        cacheWrite: null,
        cost: null,
        compaction: true,
      },
    ],
  })
})

type Part = { type: string; [key: string]: unknown }
const LAST_CALL = {
  inputTokens: { total: 32238, noCache: 2104, cacheRead: 30134, cacheWrite: undefined },
  outputTokens: { total: 1239, text: undefined, reasoning: undefined },
}

/** A Goose session whose turn emits `parts`, then settles `done` as `settle` says. */
function session(parts: Part[], settle: 'ok' | 'error' = 'ok') {
  return {
    doPromptTurn: async ({ emit }: { emit: (p: Part) => void }) => {
      for (const p of parts) emit(p)
      return {
        submitToolResult: async () => {},
        done: settle === 'ok' ? Promise.resolve() : Promise.reject(new Error('bridge closed')),
      }
    },
  } as never
}

/** Runs one turn through the session wrapper, collecting what it emits until `done` settles. */
async function turnThrough(
  ledger: { beforeTurn(): Promise<void>; afterTurn(): Promise<unknown> },
  parts: Part[],
  settle: 'ok' | 'error' = 'ok',
) {
  const out: Part[] = []
  const s = translated(session(parts, settle), [], ledger as never) as unknown as {
    doPromptTurn(o: { emit: (p: Part) => void }): Promise<{ done: Promise<void> }>
  }
  const control = await s.doPromptTurn({ emit: (p) => out.push(p) })
  const error = await control.done.then(
    () => undefined,
    (e: Error) => e,
  )
  return { out, error, control }
}

test("the session's finish waits for the ledger and carries the turn's usage, not the last call's", async () => {
  const { home, insert, db } = gooseHome()
  const ledger = new GooseLedger(local, home)
  const parts: Part[] = [
    { type: 'text-delta', id: 't', delta: 'ok' },
    { type: 'finish', finishReason: 'stop', totalUsage: LAST_CALL },
  ]
  let before = 0
  const { out, control } = await turnThrough(
    {
      beforeTurn: async () => {
        await ledger.beforeTurn()
        before++
        insert(rowsOf(captured.turns[0]?.rows as [number, number]))
      },
      afterTurn: () => ledger.afterTurn(),
    },
    parts,
  )
  assert.equal(before, 1)
  assert.equal(typeof (control as { submitToolResult?: unknown }).submitToolResult, 'function')
  assert.deepEqual(
    out.map((p) => p.type),
    ['text-delta', 'finish'],
  )
  const finish = out.at(-1) as { totalUsage: ReturnType<typeof gooseLedgerUsage> }
  assert.deepEqual(recorded(finish.totalUsage), captured.turns[0]?.wire)
  db.close()
})

test('twin: with no ledger rows the finish goes out with no usage, as before', async () => {
  const { out } = await turnThrough(
    { beforeTurn: async () => {}, afterTurn: async () => undefined },
    [{ type: 'finish', finishReason: 'stop', totalUsage: LAST_CALL }],
  )
  const finish = out.at(-1) as { totalUsage: typeof LAST_CALL }
  assert.equal(finish.totalUsage.inputTokens.total, undefined)
  assert.equal(finish.totalUsage.outputTokens.total, undefined)
})

test('a turn that fails still sends its finish, unread, and then its error', async () => {
  let read = false
  const { out, error } = await turnThrough(
    {
      beforeTurn: async () => {},
      afterTurn: async () => {
        read = true
        return undefined
      },
    },
    [{ type: 'finish', finishReason: 'error', totalUsage: LAST_CALL }],
    'error',
  )
  assert.equal(error?.message, 'bridge closed')
  assert.equal(read, false)
  assert.deepEqual(
    out.map((p) => p.type),
    ['finish'],
  )
})
