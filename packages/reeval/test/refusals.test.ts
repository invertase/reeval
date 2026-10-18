// The refusal goldens: every case in test/refusals/cases.ts, run in-process, against
// test/refusals/<segment>.json. REEVAL_UPDATE_SNAPSHOTS=1 rewrites them; review the diff.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { CASES, DIR } from './refusals/cases.ts'

const UPDATE = process.env.REEVAL_UPDATE_SNAPSHOTS === '1'

/**
 * A message with `dir` as `<dir>` and the path after it in forward slashes, so a golden reads the
 * same on Windows. A message names a path raw (`C:\T\x\nope`) or JSON-quoted (`"C:\\T\\x"`).
 */
function placeholder(message: string, dir: string): string {
  return message
    .replaceAll(JSON.stringify(dir).slice(1, -1), '<dir>')
    .replaceAll(dir, '<dir>')
    .replace(
      /<dir>((?:\\{1,2}[^\\\s"'`():]+)+)/g,
      (_, rest: string) => `<dir>${rest.replace(/\\{1,2}/g, '/')}`,
    )
}

/** What a case does: `null` when it's accepted, else its error's class and message. */
function outcome(run: () => unknown): string | null {
  try {
    run()
    return null
  } catch (error) {
    const e = error as Error
    return placeholder(`${e.name}: ${e.message}`, DIR)
  }
}

test('refusals: a Windows path reads as <dir> with forward slashes', () => {
  const dir = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\reeval-refusals-ezzUUC'
  const quoted = JSON.stringify(`${dir}\\nope\\Dockerfile`)
  assert.equal(
    placeholder(`docker({ dockerfile: ${quoted} }): ${dir}\\nope\\Dockerfile doesn't exist.`, dir),
    `docker({ dockerfile: "<dir>/nope/Dockerfile" }): <dir>/nope/Dockerfile doesn't exist.`,
  )
  assert.equal(
    placeholder(`directory(${JSON.stringify(dir)}): ${dir}\\a.txt is a file`, dir),
    'directory("<dir>"): <dir>/a.txt is a file',
  )
  assert.equal(placeholder(`in ${dir}\\big\\Dockerfile.`, dir), 'in <dir>/big/Dockerfile.')
  const posix = '/tmp/reeval-refusals-abc'
  assert.equal(
    placeholder(`directory("${posix}/nope"): ${posix}/nope doesn't exist`, posix),
    `directory("<dir>/nope"): <dir>/nope doesn't exist`,
  )
})

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
