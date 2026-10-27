// `pnpm features:matrix`: the feature × tier matrix from the real tables. It imports the test
// files for their tables, so it runs with `--import ./test/support/tables-only.mjs`.
//
//   (no flag)   print the matrix as Markdown
//   --write     write test/features/COVERAGE.md
//   --json      print { problems, markdown, current } for matrix.test.ts
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EVAL_OPTION_KEYS } from '../../src/options.ts'
import { behaviors } from '../contract.test.ts'
import { EVAL_OPTION_SPECS } from '../features/eval-options.ts'
import { inventory } from '../features/inventory.ts'
import { features, rowName } from '../features.test.ts'
import { cases } from '../plan.test.ts'
import { testDir } from './fixture.ts'
import { buildMatrix, renderMarkdown } from './matrix.ts'

const packages = join(testDir, '../..')
const coverageFile = join(testDir, 'features/COVERAGE.md')
const refusalsDir = join(testDir, 'refusals')

const refusalText = [
  readFileSync(join(refusalsDir, 'cases.ts'), 'utf8'),
  ...readdirSync(refusalsDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readFileSync(join(refusalsDir, name), 'utf8')),
].join('\n')

const matrix = buildMatrix(inventory, {
  fixtures: features.map((f) => ({
    dir: rowName(f),
    ...(f.layout ? { of: f.dir } : {}),
    tiers: f.tiers,
    canary: existsSync(join(testDir, 'features', f.dir, 'evals/canary.eval.ts')),
  })),
  planCases: cases.map((c) => `${c.dir}/${c.name}`),
  contract: behaviors.map((b) => ({ name: b.name, canary: b.canary })),
  testSource: (path) => {
    const file = join(packages, path)
    return existsSync(file) ? readFileSync(file, 'utf8') : null
  },
  evalOptionKeys: EVAL_OPTION_KEYS,
  evalOptionSpecs: EVAL_OPTION_SPECS,
  refusalText,
})
const markdown = renderMarkdown(matrix)

const flag = process.argv[2]
if (flag === '--write') {
  writeFileSync(coverageFile, markdown)
  for (const p of matrix.problems) console.error(`problem: ${p}`)
  console.log(`wrote ${coverageFile}`)
} else if (flag === '--json') {
  const current = existsSync(coverageFile) && readFileSync(coverageFile, 'utf8') === markdown
  console.log(JSON.stringify({ problems: matrix.problems, markdown, current }))
} else {
  process.stdout.write(markdown)
}
