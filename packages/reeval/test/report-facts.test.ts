// The report's per-attempt facts (`attemptFacts`) against `reeval query`'s projection of the same
// transcripts, on every corpus run, and what a report holds with and without the transcripts.
import assert from 'node:assert/strict'
import { cpSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { corpusEntries, HISTORY_DIR } from '../scripts/schema/corpus.ts'
import { nodeAtLeast, openHistoryDb } from '../src/history/db.ts'
import { leveledArchiveFiles } from '../src/history/files.ts'
import { readReportInputs } from '../src/history/report-inputs.ts'
import type { AttemptRecord, RunRecord } from '../src/history/types.ts'
import { type AttemptFacts, attemptFacts } from '../src/view/classify.ts'
import { transcriptByLine } from '../src/view/model.ts'
import { readableRecord } from '../src/view/record.ts'
import { buildRunReport, readableRunReport, runReportSchema } from '../src/view/report/index.ts'
import { tempDir } from './helpers.ts'

const entries = corpusEntries()

const recordOf = (raw: Record<string, unknown>) =>
  readableRecord(structuredClone(raw) as unknown as RunRecord)

const attemptsOf = (record: RunRecord) => record.evals.flatMap((e) => e.attempts)

const failed = (a: AttemptRecord) => a.outcome !== 'pass'

/** `history.db`'s rows for one attempt, counted as `AttemptFacts` counts them. */
function projected(
  db: Awaited<ReturnType<typeof openHistoryDb>>,
  runId: string,
  key: string,
): AttemptFacts {
  const where = 'WHERE run_id = ? AND attempt_key = ?'
  const calls = db.query(`SELECT class, COUNT(*) AS n FROM tool_calls ${where} GROUP BY class`, [
    runId,
    key,
  ]).rows as Array<{ class: keyof AttemptFacts['byClass']; n: number }>
  const byClass = { context: 0, dependency: 0, web: 0, verify: 0, workspace: 0 }
  for (const c of calls) byClass[c.class] = Number(c.n)
  const skills = db.query(
    `SELECT skill, source, COUNT(*) AS reads, MIN(line) AS firstLine FROM skill_uses ${where}
     GROUP BY skill, source ORDER BY firstLine, skill, source`,
    [runId, key],
  ).rows as AttemptFacts['skills']
  const contextFiles = db.query(
    `SELECT path, COUNT(*) AS reads, MIN(line) AS firstLine FROM context_reads ${where}
     GROUP BY path ORDER BY firstLine, path`,
    [runId, key],
  ).rows as AttemptFacts['contextFiles']
  return {
    toolCalls: Object.values(byClass).reduce((a, b) => a + b, 0),
    byClass,
    skills: skills.map((s) => ({ ...s, reads: Number(s.reads), firstLine: Number(s.firstLine) })),
    contextFiles: contextFiles.map((f) => ({
      ...f,
      reads: Number(f.reads),
      firstLine: Number(f.firstLine),
    })),
  }
}

/** `facts` with its skills and files in the order `projected` sorts them. */
const sorted = (facts: AttemptFacts): AttemptFacts => ({
  ...facts,
  skills: [...facts.skills].sort(
    (a, b) =>
      a.firstLine - b.firstLine ||
      a.skill.localeCompare(b.skill) ||
      a.source.localeCompare(b.source),
  ),
  contextFiles: [...facts.contextFiles].sort(
    (a, b) => a.firstLine - b.firstLine || a.path.localeCompare(b.path),
  ),
})

describe('attemptFacts', () => {
  test("agrees with history.db's tool_calls, skill_uses and context_reads on every corpus run", {
    skip: !nodeAtLeast(process.versions.node) && 'node:sqlite needs Node 22.13',
  }, async () => {
    let attempts = 0
    let calls = 0
    let skills = 0
    let files = 0
    for (const entry of entries) {
      const root = tempDir(`facts-${entry.name}`)
      const history = join(root, HISTORY_DIR)
      cpSync(join(entry.dir, HISTORY_DIR), history, { recursive: true })
      const db = await openHistoryDb(root, history)
      try {
        for (const run of entry.runs) {
          const record = recordOf(run.raw)
          const { facts } = await readReportInputs(join(history, record.runId), record)
          for (const a of attemptsOf(record)) {
            const mine = facts?.get(a.key)
            const where = `${entry.name} ${record.runId} ${a.key}`
            if (!mine) {
              assert.equal(a.files.transcript, undefined, `${where}: a kept transcript`)
              continue
            }
            attempts++
            calls += mine.toolCalls
            skills += mine.skills.length
            files += mine.contextFiles.length
            assert.deepEqual(sorted(mine), projected(db, record.runId, a.key), where)
          }
        }
      } finally {
        db.close()
      }
    }
    assert.ok(attempts > 0 && calls > 0, 'the corpus has transcripts with tool calls')
    assert.ok(skills > 0, 'the corpus has a skill use')
    assert.ok(files > 0, 'the corpus has a context file read')
  })

  test("finds an attempt's environment by its key, not by object identity", async () => {
    let compared = 0
    for (const entry of entries) {
      for (const run of entry.runs) {
        const record = recordOf(run.raw)
        const { facts } = await readReportInputs(join(entry.dir, HISTORY_DIR, record.runId), record)
        for (const a of attemptsOf(record)) {
          const ref = a.files.transcript
          const kept = facts?.get(a.key)
          if (!ref || !kept) continue
          const text = readFileSync(join(entry.dir, HISTORY_DIR, record.runId, ref.path), 'utf8')
          const clone = structuredClone(a)
          assert.deepEqual(attemptFacts(record, clone, transcriptByLine(text)), kept, a.key)
          if (kept.byClass.context > 0) compared++
        }
      }
    }
    assert.ok(compared > 0, 'an attempt read its environment, so a lost lookup would show')
  })

  test('numbers lines as the file does, past blank and unreadable ones', () => {
    const entry = entries.find((e) => e.name === 'fake-matrix') ?? entries[0]
    assert.ok(entry)
    const record = recordOf(entry.runs[0]?.raw as Record<string, unknown>)
    const a = attemptsOf(record)[0] as AttemptRecord
    const tool = JSON.stringify({ type: 'tool', turn: 1, tool: 'bash', input: { command: 'ls' } })
    const facts = attemptFacts(record, a, transcriptByLine(`\n{oops\n${tool}\n`))
    assert.equal(facts.toolCalls, 1)
    assert.equal(facts.byClass.workspace, 1)
    assert.deepEqual(transcriptByLine(`\n{oops\n${tool}`).slice(0, 2), [null, null])
  })
})

describe("the report's facts", () => {
  test('are on every attempt row whose transcript was read, and absent on the others', async () => {
    let withFacts = 0
    let without = 0
    for (const entry of entries) {
      for (const run of entry.runs) {
        const record = recordOf(run.raw)
        if (record.evals.length === 0) continue
        const runDir = join(entry.dir, HISTORY_DIR, record.runId)
        const inputs = await readReportInputs(runDir, record)
        const report = buildRunReport(record, inputs)
        runReportSchema.parse(JSON.parse(JSON.stringify(report)))
        for (const row of report.attempts) {
          const kept = inputs.facts?.get(row.key)
          if (kept) {
            withFacts++
            assert.deepEqual(row.facts, kept, `${record.runId} ${row.key}`)
          } else {
            without++
            assert.equal('facts' in row, false, `${record.runId} ${row.key}`)
          }
        }
        const bare = buildRunReport(record, { ...inputs, facts: undefined })
        assert.ok(
          bare.attempts.every((r) => !('facts' in r)),
          `${record.runId}: no facts without them`,
        )
      }
    }
    assert.ok(withFacts > 0 && without > 0, `${withFacts} rows with facts, ${without} without`)
  })

  test('readReportInputs reads none without the record', async () => {
    const entry = entries.find((e) =>
      e.runs.some((r) => attemptsOf(recordOf(r.raw)).some((a) => a.files.transcript)),
    )
    assert.ok(entry)
    const run = entry.runs.find((r) =>
      attemptsOf(recordOf(r.raw)).some((a) => a.files.transcript),
    ) as (typeof entry.runs)[number]
    const record = recordOf(run.raw)
    const runDir = join(entry.dir, HISTORY_DIR, record.runId)
    assert.equal((await readReportInputs(runDir)).facts, undefined)
    assert.ok((await readReportInputs(runDir, record)).facts?.size)
  })

  test("are absent, not empty, on the passing attempts whose transcripts 'evidence' drops", async () => {
    const found = entries.flatMap((entry) =>
      entry.runs.flatMap((run) => {
        const record = recordOf(run.raw)
        const kept = attemptsOf(record).filter((a) => a.files.transcript)
        return kept.some(failed) && kept.some((a) => !failed(a)) ? [{ entry, record }] : []
      }),
    )[0]
    assert.ok(found, 'a corpus run keeps a passing and a failing transcript')
    const { entry, record } = found
    const dir = join(tempDir('facts-evidence'), 'history')
    cpSync(join(entry.dir, HISTORY_DIR), dir, { recursive: true })
    const made = await leveledArchiveFiles(dir, record.runId, 'evidence', { skipSecretScan: true })
    assert.ok('files' in made)
    const file = made.files.find((f) => f.path === `${record.runId}/report.json`)
    assert.ok(file, 'the archive has report.json')
    const report = readableRunReport(JSON.parse(Buffer.from(file.data).toString()))
    const outcome = new Map(attemptsOf(record).map((a) => [a.key, a]))
    let passing = 0
    let failing = 0
    for (const row of report.attempts) {
      const a = outcome.get(row.key) as AttemptRecord
      if (!a.files.transcript) continue
      if (failed(a)) {
        failing++
        assert.ok(row.facts, `${row.key} failed, so it keeps its transcript and its facts`)
      } else {
        passing++
        assert.equal('facts' in row, false, `${row.key} passed, so evidence dropped its transcript`)
      }
    }
    assert.ok(passing > 0 && failing > 0)
  })

  test('count the source of the checked skill, once for each attempt that found it', () => {
    const record = entries
      .flatMap((entry) => entry.runs.map((r) => recordOf(r.raw)))
      .find((r) => r.evals.some((e) => e.attempts.length >= 4))
    assert.ok(record, 'a corpus eval has four attempts')
    const e = record.evals.find((x) => x.attempts.length >= 4)
    assert.ok(e)
    const [one, two, three, four] = e.attempts
    assert.ok(one && two && three && four)
    e.compare = undefined
    const check = (status: 'pass' | 'fail', label = 'toHaveCalledSkill x') =>
      [
        {
          label,
          labelled: label !== 'toHaveCalledSkill x',
          matcher: 'toHaveCalledSkill',
          status,
        },
      ] as NonNullable<AttemptRecord['assertions']>
    for (const a of [one, two, three, four]) a.outcome = 'pass'
    one.assertions = check('pass')
    two.assertions = check('pass')
    three.assertions = check('fail')
    four.assertions = check('pass', 'found the skill')
    type Use = [skill: string, source: AttemptFacts['skills'][number]['source'], line: number]
    const facts = (...uses: Use[]): AttemptFacts => ({
      toolCalls: uses.length,
      byClass: { context: uses.length, dependency: 0, web: 0, verify: 0, workspace: 0 },
      skills: uses.map(([skill, source, firstLine]) => ({ skill, source, reads: 1, firstLine })),
      contextFiles: [],
    })
    const evals = [e.key]
    const discovery = (f?: Map<string, AttemptFacts>) =>
      buildRunReport(record, { evals, facts: f }).evals[0]?.discovery.find(
        (d) => d.what === 'skill',
      )
    assert.deepEqual(discovery()?.sources, [])
    const uses = new Map([
      // Two skills: only the checked one, x, counts.
      [one.key, facts(['y', 'placed', 1], ['x', 'elsewhere', 3])],
      // x from two sources: its first use counts.
      [two.key, facts(['x', 'elsewhere', 9], ['x', 'skill-dir', 4])],
      [three.key, facts(['x', 'skill-dir', 2])],
      [four.key, facts(['plugin:x', 'placed', 2])],
    ])
    const ownLabel = discovery(uses)
    assert.equal(ownLabel?.found.text, '3 of 4')
    assert.deepEqual(
      ownLabel?.sources,
      [
        { source: 'skill-dir', count: 1 },
        { source: 'elsewhere', count: 1 },
      ],
      "a check with a label of its own doesn't name the skill, so its attempt counts in none",
    )
    four.assertions = check('pass')
    const all = discovery(uses)
    assert.deepEqual(all?.sources, [
      { source: 'placed', count: 1 },
      { source: 'skill-dir', count: 1 },
      { source: 'elsewhere', count: 1 },
    ])
    assert.equal(
      all?.sources.reduce((n, s) => n + s.count, 0),
      all?.found.k,
      'the sources sum to found',
    )
  })
})
