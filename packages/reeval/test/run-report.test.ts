import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { corpusEntries } from '../scripts/schema/corpus.ts'
import type { RunRecord } from '../src/history/types.ts'
import { FORBIDDEN_OUTPUT, runReportMarkdown } from '../src/renderer/markdown.ts'
import type { CompareRow } from '../src/view/compare.ts'
import { NewerSchemaError, readableRecord } from '../src/view/record.ts'
import {
  buildRunReport,
  REPORT_VERSION,
  readableRunReport,
  runReportSchema,
} from '../src/view/report/index.ts'

function loadCorpusRun(name: string): RunRecord {
  const file = corpusEntries()
    .find((e) => e.name === name)
    ?.runs.at(-1)?.file
  assert.ok(file, `${name} has a run`)
  return readableRecord(JSON.parse(readFileSync(file, 'utf8')) as RunRecord)
}

function cloneRecord(name: string): RunRecord {
  return structuredClone(loadCorpusRun(name))
}

describe('buildRunReport', () => {
  test('parses with runReportSchema and emits clean GFM for every corpus entry', () => {
    for (const entry of corpusEntries()) {
      const file = entry.runs.at(-1)?.file
      if (!file) continue
      const record = readableRecord(JSON.parse(readFileSync(file, 'utf8')) as RunRecord)
      const report = buildRunReport(record, { linkBase: './' })
      assert.doesNotThrow(() => runReportSchema.parse(report), entry.name)
      const md = runReportMarkdown(report)
      for (const forbidden of FORBIDDEN_OUTPUT) {
        assert.doesNotMatch(md, forbidden.pattern, `${entry.name}: ${forbidden.name}`)
      }
      assert.equal([...md.matchAll(/^# /gm)].length, 1, `${entry.name}: one H1`)
      assert.doesNotMatch(md, /\blinesAdded\b/, `${entry.name}: no measure enum keys`)
      assert.doesNotMatch(md, /\b(private|product)[ -]?study\b/i)
    }
  })

  test('single-eval filter promotes the eval name to H1 and omits the roster', () => {
    const record = loadCorpusRun('with-layouts')
    const key = record.evals[0]?.key
    assert.ok(key)
    const report = buildRunReport(record, { evals: [key], linkBase: './' })
    assert.equal(report.single, true)
    assert.equal(report.evals.length, 1)
    assert.equal(report.roster.length, 0)
    const md = runReportMarkdown(report)
    assert.match(
      md,
      new RegExp(`^# ${report.header.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm'),
    )
    assert.doesNotMatch(md, /^## .+\n\n`[^`]+`\. /m)
    assert.doesNotMatch(md, /^## Coding harness roster/m)
  })

  test('regression headline leads with worse/fixed and prior-run context', () => {
    const head = cloneRecord('with-layouts')
    const prior = cloneRecord('with-layouts')
    prior.runId = 'prior-run-id'
    prior.startedAt = '2026-01-02T12:00:00.000Z'
    prior.git = {
      sha: 'abcdef1234567890',
      branch: 'main',
      dirty: false,
      diffHash: null,
      remote: 'https://example.com/demo.git',
      worktreePatch: null,
    }
    prior.author = 'fixture-author'
    const evalKey = head.evals[0]!.key
    const rows: CompareRow[] = [
      {
        id: evalKey,
        status: 'regressed',
        base: 'pass',
        head: 'fail',
        gate: { base: 'all', head: 'all', rescored: 'pass' },
        perCell: [
          {
            key: 'cell',
            base: { pass: 2, fail: 0, lift: null, effort: null },
            head: { pass: 0, fail: 2, lift: null, effort: null },
          },
        ],
      },
    ]
    const report = buildRunReport(head, {
      evals: [evalKey],
      linkBase: './',
      prior: {
        record: prior,
        rows,
        changes: [
          {
            field: 'judgeModel',
            label: 'judge model',
            base: 'a',
            head: 'b',
            outsideFingerprint: false,
          },
        ],
      },
    })
    assert.doesNotThrow(() => runReportSchema.parse(report))
    const primary = report.evals[0]!.headline.primary
    assert.equal(primary.kind, 'regression')
    if (primary.kind !== 'regression') return
    assert.equal(primary.worse, 1)
    assert.equal(primary.fixed, 0)
    assert.ok(primary.lead)
    assert.equal(primary.lead?.prior, '2 of 2')
    assert.equal(primary.lead?.current, '0 of 2')
    assert.equal(report.evals[0]!.headline.fairness, 'too-few-runs')
    assert.ok(report.integrity.some((i) => i.kind === 'fairness-floor'))
    const block = report.evals[0]!.primary
    assert.equal(block?.kind, 'regression')
    if (block?.kind === 'regression') {
      assert.equal(block.prior.runId, 'prior-run-id')
      assert.equal(block.prior.gitSha, 'abcdef1234567890')
      assert.ok(block.whatChanged.some((line) => /judge model/.test(line)))
    }
    const md = runReportMarkdown(report)
    assert.match(md, /\*\*1 worse: .+2 of 2 to 0 of 2\*\*/)
    assert.match(md, /Changes since 2026-01-02, abcdef1(?:, main)?, prior-run-id/)
    assert.match(md, /Prior run by fixture-author/)
    assert.match(md, /What changed/)
  })

  test('pass-rate headlines name found/used outcomes from discovery matchers', () => {
    const record = cloneRecord('with-layouts')
    const e = record.evals.find((ev) => !ev.compare) ?? record.evals[0]!
    for (const a of e.attempts) {
      a.assertions = [
        {
          label: 'used skill',
          matcher: 'toHaveCalledSkill',
          status: 'pass',
          soft: false,
        },
      ]
    }
    const report = buildRunReport(record, { evals: [e.key], linkBase: './' })
    const primary = report.evals[0]!.headline.primary
    assert.equal(primary.kind, 'pass-rate')
    if (primary.kind === 'pass-rate') assert.equal(primary.outcome, 'used')
    assert.match(runReportMarkdown(report), /\*\*\d+% used\*\*/)
  })

  test('pre-satisfied checks emit integrity and keep full wording', () => {
    const record = cloneRecord('with-layouts')
    const e = record.evals.find((ev) => !ev.compare) ?? record.evals[0]!
    const attempt = e.attempts.find((a) => a.outcome === 'pass' || a.outcome === 'fail')
    assert.ok(attempt)
    attempt.assertions = [
      {
        label: 'has index',
        matcher: 'toHaveFile',
        status: 'pass',
        soft: false,
        preSatisfied: true,
      },
      {
        label: 'skipped on baseline',
        matcher: 'toHaveCalledSkill',
        status: 'not_applicable',
        soft: true,
        reason: 'baseline has no skill',
      },
    ]
    const report = buildRunReport(record, { evals: [e.key], linkBase: './' })
    assert.ok(report.integrity.some((i) => i.kind === 'pre-satisfied'))
    const task = report.evals[0]!.primary
    assert.equal(task?.kind, 'task')
    if (task?.kind !== 'task') return
    const pre = task.assertions.find((row) => row.label === 'has index')
    assert.ok(pre)
    assert.match(pre!.total.text, /pre-satisfied/)
    const na = task.assertions.find((row) => row.label === 'skipped on baseline')
    assert.ok(na)
    assert.equal(na!.total.reason, 'baseline has no skill')
    assert.match(na!.total.text, /baseline has no skill/)
  })

  test('diagnostic judges omit at-or-above tallies', () => {
    const record = cloneRecord('with-layouts')
    const e = record.evals.find((ev) => !ev.compare) ?? record.evals[0]!
    for (const a of e.attempts.slice(0, 2)) {
      a.judgements = [
        {
          key: '0:diag',
          label: 'clarity',
          question: 'Is the change clear?',
          verdict: 'pass',
          score: 0.8,
          threshold: 0.5,
          model: 'fake',
        },
      ]
      // No toPass assertion → diagnostic; scored threshold must not invent an at-or-above tally.
      a.assertions = []
    }
    const report = buildRunReport(record, { evals: [e.key], linkBase: './' })
    const judgments = report.evals[0]!.judgments
    assert.ok(judgments)
    assert.equal(judgments!.scores[0]!.threshold, null)
    assert.equal(judgments!.scores[0]!.atOrAbove, null)
    const md = runReportMarkdown(report)
    assert.match(md, /diagnostic/)
    assert.doesNotMatch(md, /At or above/)
  })

  test('A/B tables name pass-rate verdicts with product labels', () => {
    const record = loadCorpusRun('with-layouts')
    const e = record.evals.find((ev) => ev.compare)
    assert.ok(e)
    const report = buildRunReport(record, { evals: [e!.key], linkBase: './' })
    const comparison = report.evals[0]!.primary
    assert.equal(comparison?.kind, 'comparison')
    if (comparison?.kind === 'comparison') {
      assert.ok(comparison.summary.every((row) => row.verdictScope === 'pass-rate'))
    }
    const md = runReportMarkdown(report)
    assert.match(md, /Pass-rate verdict/)
    assert.doesNotMatch(md, /\| made-worse \|/)
    assert.doesNotMatch(md, /\| pass-rate \|/)
  })

  test('cost header labels agent, judge, and basis', () => {
    const record = cloneRecord('with-layouts')
    record.cost = {
      agentUsd: { usd: 1.25, basis: 'reported', source: 'fixture' },
      judgeUsd: { usd: 0.25, basis: 'estimated', source: 'fixture' },
    }
    const report = buildRunReport(record, { linkBase: './' })
    assert.ok(report.header.cost)
    assert.equal(report.header.cost!.basis, 'mixed')
    assert.ok(report.header.cost!.agent)
    assert.ok(report.header.cost!.judge)
    assert.ok(report.header.cost!.total)
    assert.match(runReportMarkdown(report), /agent \$.+, judge \$.+ \(mixed\)/)
  })

  test('colliding transcript paths get distinct attempt hrefs', () => {
    const record = cloneRecord('with-layouts')
    const e = record.evals.find((ev) => ev.compare && ev.attempts.length >= 2)
    assert.ok(e)
    const [a, b] = e!.attempts
    assert.ok(a && b)
    const shared = {
      path: 'shared/transcript.jsonl',
      sha256: '0'.repeat(64),
      bytes: 1,
    }
    a.files.transcript = shared
    b.files.transcript = { ...shared }
    const report = buildRunReport(record, { evals: [e!.key], linkBase: './' })
    const hrefs = report.attempts.map((row) => row.href)
    assert.equal(new Set(hrefs).size, hrefs.length)
    assert.ok(hrefs.some((h) => h.includes('shared/transcript.jsonl')))
    assert.ok(hrefs.some((h) => /^#a\d+$/.test(h)))
  })

  test('text headlines disclose representative multi-answer collapse', () => {
    const record = cloneRecord('with-layouts')
    const e = record.evals.find((ev) => !ev.compare) ?? record.evals[0]!
    e.attempts = e.attempts.slice(0, 2).map((a, i) => ({
      ...a,
      assertions: [],
      answers: [
        {
          question: 'What stood out?',
          text: `Answer ${i + 1}`,
          choice: null,
          input: null,
        },
      ],
    }))
    // Clear choices/judgments so text path wins.
    for (const a of e.attempts) {
      a.judgments = []
      a.observations = []
    }
    e.answers = undefined
    const report = buildRunReport(record, { evals: [e.key], linkBase: './' })
    const primary = report.evals[0]!.headline.primary
    assert.equal(primary.kind, 'text')
    if (primary.kind === 'text') {
      assert.equal(primary.leadRole, 'representative')
      assert.ok(primary.answered.k >= 2)
    }
    assert.match(runReportMarkdown(report), /Showing 1 of \d+ answers as representative/)
  })
})

describe('readableRunReport', () => {
  const golden = () =>
    JSON.parse(
      readFileSync(new URL('./fixtures/summary/with-layouts/report.json', import.meta.url), 'utf8'),
    ) as Record<string, unknown>

  /** The report's `z.record` fields, whose own keys are data, not fields. */
  const RECORDS = new Set(['cells', 'counts'])

  /** Adds `newerField` to every object in `value`, at every depth; returns how many it marked. */
  function markEveryObject(value: unknown, record = false): number {
    if (Array.isArray(value)) return value.reduce((n, v) => n + markEveryObject(v), 0)
    if (typeof value !== 'object' || value === null) return 0
    let n = record ? 0 : 1
    for (const [k, v] of Object.entries(value)) n += markEveryObject(v, RECORDS.has(k))
    if (!record) (value as Record<string, unknown>).newerField = { from: 'a newer reeval' }
    return n
  }

  test('passes unknown fields at every level, which the strict schema refuses', () => {
    const report = golden()
    const marked = markEveryObject(report)
    assert.ok(marked > 100, `marked ${marked} objects`)
    assert.throws(() => runReportSchema.parse(report))
    const read = readableRunReport(structuredClone(report))
    assert.deepEqual(read, report, 'every unknown field is kept')
  })

  test('still refuses a missing or mistyped field', () => {
    const missing = golden()
    delete (missing.header as Record<string, unknown>).title
    assert.throws(() => readableRunReport(missing))
    const mistyped = golden()
    ;(mistyped.attempts as Array<Record<string, unknown>>)[0]!.id = 7
    assert.throws(() => readableRunReport(mistyped))
    const empty = golden()
    empty.evals = []
    assert.throws(() => readableRunReport(empty), 'evals keeps its .min(1)')
  })

  test('refuses a report from a newer reeval', () => {
    const newer = { ...golden(), reportVersion: REPORT_VERSION + 1 }
    assert.throws(() => readableRunReport(newer), NewerSchemaError)
  })
})
