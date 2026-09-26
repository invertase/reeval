// `pnpm features:matrix`: the feature × tier matrix from the real tables. It imports the test
// files for their tables, so it runs with `--import ./test/support/tables-only.mjs`.
//
//   (no flag)   print the matrix as Markdown
//   --write     write test/features/COVERAGE.md
//   --json      print { problems, markdown, current } for matrix.test.ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { behaviours } from '../contract.test.ts'
import { inventory } from '../features/inventory.ts'
import { features } from '../features.test.ts'
import { cases } from '../plan.test.ts'
import { testDir } from './fixture.ts'
import { buildMatrix, renderMarkdown } from './matrix.ts'

const packages = join(testDir, '../..')
const coverageFile = join(testDir, 'features/COVERAGE.md')

const matrix = buildMatrix(inventory, {
  fixtures: features.map((f) => ({
    dir: f.dir,
    tiers: f.tiers,
    canary: existsSync(join(testDir, 'features', f.dir, 'evals/canary.es.ts')),
  })),
  planCases: cases.map((c) => `${c.dir}/${c.name}`),
  contract: behaviours.map((b) => ({ name: b.name, canary: b.canary })),
  testSource: (path) => {
    const file = join(packages, path)
    return existsSync(file) ? readFileSync(file, 'utf8') : null
  },
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
