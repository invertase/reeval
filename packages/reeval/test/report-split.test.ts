import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { corpus, corpusEntries } from '../scripts/schema/corpus.ts'
import type { RunRecord } from '../src/history/types.ts'
import { readableRecord } from '../src/view/record.ts'
import {
  buildRunReport,
  joinRunReport,
  type RunReport,
  readableRunReport,
  splitRunReport,
} from '../src/view/report/index.ts'

// The with-layouts golden (14 evals, 57 attempts) is a 142 KB report whose index is 32 KB: the
// header, integrity, rollup, roster and each eval's headline. Its evals' blocks and the attempt
// index, which grow with the run, are in the details. The bound leaves room for a few more evals
// and integrity issues, and fails once a per-eval block or the attempt rows leak into the index.
const INDEX_BOUND = 40 * 1024

const golden = (): RunReport =>
  readableRunReport(
    JSON.parse(
      readFileSync(new URL('./fixtures/summary/with-layouts/report.json', import.meta.url), 'utf8'),
    ),
  )

/** `report` split and joined again, checked against itself key by key and byte by byte. */
function roundTrips(report: RunReport, what: string) {
  const { index, details } = splitRunReport(report)
  const joined = joinRunReport(index, details)
  assert.deepEqual(joined, report, what)
  assert.equal(JSON.stringify(joined), JSON.stringify(report), `${what}: keys in the same order`)
  assert.equal('attempts' in index, false, what)
  assert.deepEqual(
    index.evals.map((e) => e.id),
    report.evals.map((e) => e.id),
    what,
  )
  for (const d of details) {
    assert.equal(d.runId, report.runId, what)
    assert.ok(
      d.attempts.every((a) => a.evalId === d.eval.id),
      `${what}: ${d.eval.id}'s rows are its own`,
    )
    assert.equal(index.evals.find((e) => e.id === d.eval.id)?.attempts, d.attempts.length, what)
  }
  return { index, details }
}

describe('splitRunReport', () => {
  test("round-trips every corpus run's report.json", () => {
    const { reports } = corpus()
    assert.ok(reports.length > 0, 'the corpus has a report.json')
    for (const { file, value } of reports) roundTrips(readableRunReport(value), file)
  })

  test('round-trips the report of every corpus run, as the studio builds it', () => {
    let n = 0
    for (const entry of corpusEntries()) {
      for (const run of entry.runs) {
        const record = readableRecord(run.raw as RunRecord)
        if (record.evals.length === 0) continue
        const base = `/api/v1/runs/${record.runId}/artifacts/`
        roundTrips(
          buildRunReport(record, { links: { base, record: `${base}${record.runId}.json` } }),
          `${entry.name} ${run.runId}`,
        )
        n++
      }
    }
    assert.ok(n > 10, `${n} corpus runs`)
  })

  test('round-trips the with-layouts golden, and its index stays under the bound', () => {
    const report = golden()
    const { index, details } = roundTrips(report, 'with-layouts')
    const size = JSON.stringify(index).length
    assert.ok(size < INDEX_BOUND, `the index is ${size} bytes`)
    assert.ok(size < JSON.stringify(report).length / 3, 'the index is under a third of the report')
    assert.equal(details.length, report.evals.length)
  })

  test('round-trips a one-eval report', () => {
    const record = readableRecord(
      corpusEntries()
        .find((e) => e.name === 'with-layouts')
        ?.runs.at(-1)?.raw as RunRecord,
    )
    const key = record.evals[1]?.key as string
    roundTrips(buildRunReport(record, { evals: [key] }), 'one eval')
  })

  test('refuses an eval id used twice, an attempt row naming no eval, or rows out of order', () => {
    const report = golden()
    const orphan = structuredClone(report)
    ;(orphan.attempts[0] as RunReport['attempts'][number]).evalId = 'no such eval'
    assert.throws(() => splitRunReport(orphan), /names eval no such eval/)
    const twice = structuredClone(report)
    twice.evals[1] = {
      ...(twice.evals[1] as RunReport['evals'][number]),
      id: twice.evals[0]?.id as string,
    }
    assert.throws(() => splitRunReport(twice), /is in the report twice/)
    const shuffled = structuredClone(report)
    shuffled.attempts.reverse()
    assert.throws(() => splitRunReport(shuffled), /out of the index's order/)
  })
})
