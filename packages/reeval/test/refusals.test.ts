// The refusal goldens: every case in test/refusals/cases.ts, run in-process, against
// test/refusals/<segment>.json. REEVAL_UPDATE_SNAPSHOTS=1 rewrites them; review the diff.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { CASES, DIR } from './refusals/cases.ts'

const UPDATE = process.env.REEVAL_UPDATE_SNAPSHOTS === '1'

/** What a case does: `null` when it's accepted, else its error's class and message. */
function outcome(run: () => unknown): string | null {
  try {
    run()
    return null
  } catch (error) {
    const e = error as Error
    return `${e.name}: ${e.message}`.replaceAll(DIR, '<dir>')
  }
}

for (const [segment, cases] of Object.entries(CASES)) {
  test(`refusals: ${segment}`, () => {
    const names = cases.map(([name]) => name)
    assert.equal(new Set(names).size, names.length, `a case name repeats in ${segment}`)
    const actual = Object.fromEntries(cases.map(([name, run]) => [name, outcome(run)]))
    const file = new URL(`./refusals/${segment}.json`, import.meta.url)
    if (UPDATE) writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`)
    assert.deepEqual(actual, JSON.parse(readFileSync(file, 'utf8')))
  })
}
