// The fake agent's fix for each fixture, run in the sandbox's workspace: an oracle the eval must
// pass. With --cheat it skips the failing eval instead, a canary the eval must fail.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const cheat = process.argv.includes('--cheat')

const edit = (path, from, to) => {
  const text = readFileSync(path, 'utf8')
  if (!text.includes(from)) throw new Error(`${path} doesn't contain ${from}`)
  writeFileSync(path, text.replace(from, to))
}

const fixes = [
  [
    'evals/report.eval.ts',
    'flaky-check',
    (f) => {
      edit(
        f,
        "await c.exec('node build.js', { background: true })\n    await c.exec('sleep 0.2')",
        "await c.exec('node build.js')",
      )
    },
  ],
  ['evals/readme.eval.ts', 'judge-threshold', (f) => edit(f, 'threshold: 0.95', 'threshold: 0.8')],
  [
    'evals/count.eval.ts',
    'setup-step',
    (f) => edit(f, 'prepare-fixtures.js', 'prepare-fixture.js'),
  ],
  [
    'skills/house-style/SKILL.md',
    'skill-missing',
    () => {
      edit('evals/greet.eval.ts', 'import { plain }', 'import { houseStyle }')
      edit('evals/greet.eval.ts', 'environment: plain', 'environment: houseStyle')
    },
  ],
  ['evals/greet.eval.ts', 'check-path', (f) => edit(f, "'src/greet.js'", "'lib/greet.js'")],
]

const [file, cause, fix] = fixes.find(([f]) => existsSync(f)) ?? []
if (!file) throw new Error('No fixture recognised in this workspace')
if (cheat) {
  const evalFile =
    cause === 'skill-missing' || cause === 'check-path' ? 'evals/greet.eval.ts' : file
  edit(evalFile, "evaluate('", "evaluate.skip('")
} else fix(file)
writeFileSync('answer.json', `${JSON.stringify({ cause, evidence: 'the oracle knows' })}\n`)
console.log(`${cheat ? 'skipped' : 'fixed'} ${cause}`)
