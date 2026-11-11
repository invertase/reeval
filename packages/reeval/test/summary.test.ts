// Golden summary.md / report.json snapshots from RunReport. Sources are corpus runs already in
// the repo (anonymized layout fixtures). REEVAL_UPDATE_SNAPSHOTS=1 rewrites both files.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { corpusEntries } from '../scripts/schema/corpus.ts'
import type { RunRecord } from '../src/history/types.ts'
import { readableRecord } from '../src/view/record.ts'
import {
  buildRunReport,
  FORBIDDEN_OUTPUT,
  runReportMarkdown,
  runReportSchema,
} from '../src/view/report/index.ts'

const UPDATE = !!process.env.REEVAL_UPDATE_SNAPSHOTS
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))
const FIXTURES = join(PACKAGE_DIR, 'test/fixtures/summary')

/** Corpus entries that seed anonymized summary goldens (no private study names). */
const GOLDENS = [{ name: 'with-layouts', corpus: 'with-layouts' }] as const

function loadCorpus(name: string): RunRecord {
  const file = corpusEntries()
    .find((e) => e.name === name)
    ?.runs.at(-1)?.file
  assert.ok(file, `${name} has a run`)
  return readableRecord(JSON.parse(readFileSync(file, 'utf8')) as RunRecord)
}

describe('summary.md goldens', () => {
  for (const g of GOLDENS) {
    test(g.name, () => {
      const record = loadCorpus(g.corpus)
      const report = buildRunReport(record, { linkBase: './' })
      assert.doesNotThrow(() => runReportSchema.parse(report))
      const md = runReportMarkdown(report)
      for (const forbidden of FORBIDDEN_OUTPUT) {
        assert.doesNotMatch(md, forbidden.pattern, forbidden.name)
      }
      assert.doesNotMatch(md, /firebase|ben-cook|elliot-hesp|russellwheatley|private.?study/i)
      const dir = join(FIXTURES, g.name)
      const mdPath = join(dir, 'summary.md')
      const jsonPath = join(dir, 'report.json')
      if (UPDATE) {
        mkdirSync(dir, { recursive: true })
        writeFileSync(mdPath, md)
        writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`)
        return
      }
      assert.equal(md, readFileSync(mdPath, 'utf8'), `${g.name}/summary.md`)
      assert.deepEqual(report, JSON.parse(readFileSync(jsonPath, 'utf8')), `${g.name}/report.json`)
    })
  }
})
