import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { corpusEntries } from '../scripts/schema/corpus.ts'
import type { RunRecord } from '../src/history/types.ts'
import { FORBIDDEN_OUTPUT, runReportMarkdown } from '../src/renderer/markdown.ts'
import type { CompareRow } from '../src/view/compare.ts'
import { NewerSchemaError, readableRecord } from '../src/view/record.ts'
import {
  attemptAnchor,
  attemptAnchorId,
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
      const report = buildRunReport(record, { links: { base: './' } })
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
    const report = buildRunReport(record, { evals: [key], links: { base: './' } })
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
      links: { base: './' },
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
    const report = buildRunReport(record, { evals: [e.key], links: { base: './' } })
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
    const report = buildRunReport(record, { evals: [e.key], links: { base: './' } })
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
    const report = buildRunReport(record, { evals: [e.key], links: { base: './' } })
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
    const report = buildRunReport(record, { evals: [e!.key], links: { base: './' } })
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
    const report = buildRunReport(record, { links: { base: './' } })
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
    const report = buildRunReport(record, { evals: [e!.key], links: { base: './' } })
    const hrefs = report.attempts.map((row) => row.href)
    assert.equal(new Set(hrefs).size, hrefs.length)
    assert.ok(hrefs.some((h) => h.includes('shared/transcript.jsonl')))
    assert.ok(hrefs.includes(attemptAnchor(b.key)), 'the second falls back to its anchor')
    assert.match(attemptAnchor(b.key), /^#attempt-[a-z0-9-]+$/)
  })

  test('attempt anchors come from the stable key, the same in any report of the run, and each resolves', () => {
    const record = loadCorpusRun('with-layouts')
    const whole = buildRunReport(record)
    const lastSeq = (e: (typeof record.evals)[number]) =>
      Math.max(-1, ...e.attempts.map((a) => a.seq ?? -1))
    const last = [...record.evals].sort((a, b) => lastSeq(b) - lastSeq(a))[0]
    assert.ok(last)
    const one = buildRunReport(record, { evals: [last.key] })
    const keyOf = (r: typeof whole) => new Map(r.attempts.map((a) => [a.key, a]))
    const all = keyOf(whole)
    let renumbered = 0
    for (const row of one.attempts) {
      const same = all.get(row.key)
      assert.ok(same, row.key)
      if (same.id !== row.id) renumbered++
      if (row.href.startsWith('#')) assert.equal(row.href, same.href, 'the anchor is the same')
    }
    assert.ok(renumbered > 0, 'the one-eval report numbers its attempts from A1')
    const md = runReportMarkdown(whole)
    const targets = new Set([...md.matchAll(/<a id="([^"]+)"><\/a>/g)].map((m) => m[1]))
    assert.equal(targets.size, whole.attempts.length, 'one anchor per attempt, all distinct')
    for (const a of whole.attempts) assert.ok(targets.has(attemptAnchorId(a.key)), a.key)
    const links = [...md.matchAll(/\]\(#(attempt-[^)]+)\)/g)].map((m) => m[1] as string)
    for (const link of links) assert.ok(targets.has(link), `#${link} has a target`)
    const cites = JSON.stringify(whole).match(/"id":"A\d+","key":"[^"]+"/g) ?? []
    assert.ok(cites.length > 0, 'every AttemptRef carries its key')
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
    const report = buildRunReport(record, { evals: [e.key], links: { base: './' } })
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
    assert.throws(() => readableRunReport(missing), {
      message: "This report's header.title is missing: it must be a string",
    })
    const mistyped = golden()
    ;(mistyped.attempts as Array<Record<string, unknown>>)[0]!.id = 7
    assert.throws(() => readableRunReport(mistyped, 'report.json'), {
      message: "report.json's attempts[0].id must be a string (got 7)",
    })
    const empty = golden()
    empty.evals = []
    assert.throws(() => readableRunReport(empty), {
      message: "This report's evals must hold at least one eval (got [])",
    })
    const variant = golden()
    const section = (variant.evals as Array<Record<string, unknown>>)[0]!
    section.primary = { kind: 'future-kind' }
    assert.throws(
      () => readableRunReport(variant),
      /^Error: This report's evals\[0\]\.primary[^\n]+$/,
    )
  })

  test('refuses a report from a newer reeval', () => {
    const newer = { ...golden(), reportVersion: REPORT_VERSION + 1 }
    assert.throws(() => readableRunReport(newer), NewerSchemaError)
    assert.throws(
      () => readableRunReport(newer),
      new RegExp(
        `This report was written by a newer reeval \\(reportVersion ${REPORT_VERSION + 1}; `,
      ),
    )
  })
})

describe('RunReport links', () => {
  test('links.base prefixes artifact links and links.record replaces the record href', () => {
    const record = loadCorpusRun('with-layouts')
    const plain = buildRunReport(record)
    assert.equal(plain.provenance.record, `../${record.runId}.json`, 'the record beside the folder')
    const base = `/runs/${record.runId}/files/`
    const hosted = buildRunReport(record, {
      links: { base, record: `/runs/${record.runId}/record` },
    })
    assert.equal(hosted.provenance.record, `/runs/${record.runId}/record`)
    const transcripts = hosted.attempts.flatMap((a) => a.links.transcript ?? [])
    assert.ok(transcripts.length > 0)
    for (const t of transcripts) assert.ok(t.startsWith(base), t)
    assert.doesNotMatch(JSON.stringify(hosted), /"\.\/[^"]+"/, 'no link is left relative to ./')
  })

  test('links.base is a folder with or without its trailing /', () => {
    const record = loadCorpusRun('with-layouts')
    const slashed = JSON.stringify(buildRunReport(record, { links: { base: 'https://h/x/' } }))
    const bare = JSON.stringify(buildRunReport(record, { links: { base: 'https://h/x' } }))
    assert.equal(bare, slashed)
    assert.match(bare, /"https:\/\/h\/x\/evals-/)
    assert.doesNotMatch(bare, /https:\/\/h\/x[^/]/)
    assert.equal(
      JSON.stringify(buildRunReport(record, { links: { base: './' } })),
      JSON.stringify(buildRunReport(record)),
      './ is the default',
    )
  })
})
