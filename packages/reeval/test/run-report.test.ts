import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { corpusEntries } from '../scripts/schema/corpus.ts'
import type { RunRecord } from '../src/history/types.ts'
import { readableRecord } from '../src/view/record.ts'
import {
  buildRunReport,
  FORBIDDEN_OUTPUT,
  runReportMarkdown,
  runReportSchema,
} from '../src/view/report/index.ts'

function loadCorpusRun(name: string): RunRecord {
  const file = corpusEntries()
    .find((e) => e.name === name)
    ?.runs.at(-1)?.file
  assert.ok(file, `${name} has a run`)
  return readableRecord(JSON.parse(readFileSync(file, 'utf8')) as RunRecord)
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
    }
  })

  test('single-eval filter promotes the eval name to H1', () => {
    const record = loadCorpusRun('with-layouts')
    const key = record.evals[0]?.key
    assert.ok(key)
    const report = buildRunReport(record, { evals: [key], linkBase: './' })
    assert.equal(report.single, true)
    assert.equal(report.evals.length, 1)
    const md = runReportMarkdown(report)
    assert.match(
      md,
      new RegExp(`^# ${report.header.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm'),
    )
    assert.doesNotMatch(md, /^## .+\n\n`[^`]+`\. /m)
  })
})
