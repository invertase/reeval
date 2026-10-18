// The fake agent's answer for each fixture, run in the sandbox's workspace: an oracle the eval must
// pass. With --cheat it skips the failing eval or gives a wrong answer instead, a canary the eval
// must fail.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const cheat = process.argv.includes('--cheat')
const task = process.env.DOGFOOD_TASK

const edit = (path, from, to) => {
  const text = readFileSync(path, 'utf8')
  if (!text.includes(from)) throw new Error(`${path} doesn't contain ${from}`)
  writeFileSync(path, text.replace(from, to))
}
const answer = (value) => writeFileSync('answer.json', `${JSON.stringify(value)}\n`)
const commitOf = (message) =>
  execFileSync('git', ['log', '--format=%H', `--grep=^${message}$`], { encoding: 'utf8' }).trim()

/** Fixes that make `reeval run` pass, and the eval file the cheat skips instead. */
const fixes = {
  'flaky-check': [
    'evals/report.eval.ts',
    () =>
      edit(
        'evals/report.eval.ts',
        "await c.exec('node build.js', { background: true })\n    await c.exec('sleep 0.2')",
        "await c.exec('node build.js')",
      ),
  ],
  'judge-threshold': [
    'evals/readme.eval.ts',
    () => edit('evals/readme.eval.ts', 'threshold: 0.95', 'threshold: 0.8'),
  ],
  'setup-step': [
    'evals/count.eval.ts',
    () => edit('evals/count.eval.ts', 'prepare-fixtures.js', 'prepare-fixture.js'),
  ],
  'skill-missing': [
    'evals/greet.eval.ts',
    () => {
      edit('evals/greet.eval.ts', 'import { plain }', 'import { houseStyle }')
      edit('evals/greet.eval.ts', 'environment: plain', 'environment: houseStyle')
    },
  ],
  'check-path': [
    'evals/greet.eval.ts',
    () => edit('evals/greet.eval.ts', "'src/greet.js'", "'lib/greet.js'"),
  ],
  'big-record': [
    'evals/export.eval.ts',
    () => edit('evals/export.eval.ts', "toHaveFile('src/export.js'", "toHaveFile('lib/export.js'"),
  ],
}

/** What each history question's answer is, and a plausible wrong one. */
const answers = {
  'flaky-since': () => ({
    eval: 'builds the report',
    commit: commitOf(`update evals (batch ${cheat ? 6 : 5})`),
    cause: 'check',
  }),
  regression: () => ({
    regressed: cheat
      ? ['pads a string', 'removes duplicates', 'clamps a number']
      : ['pads a string', 'removes duplicates'],
  }),
  'is-new': () =>
    cheat
      ? { new: ['title-cases a phrase', 'builds the report'], old: ['clamps a number'] }
      : { new: ['title-cases a phrase'], old: ['clamps a number', 'builds the report'] },
}

if (answers[task]) {
  answer(answers[task]())
} else if (fixes[task]) {
  const [file, fix] = fixes[task]
  if (cheat) edit(file, "evaluate('", "evaluate.skip('")
  else fix()
  answer({ cause: task === 'big-record' ? 'check-path' : task, evidence: 'the oracle knows' })
} else throw new Error(`No fixture named ${task}`)
console.log(`${cheat ? 'cheated on' : 'answered'} ${task}`)
