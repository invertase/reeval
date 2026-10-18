import { evaluate, expect, group } from 'reeval'
import { brokenProject } from './environments.ts'

const CAUSES = [
  'agent-error',
  'check-path',
  'judge-threshold',
  'skill-missing',
  'flaky-check',
  'setup-step',
  'egress-blocked',
  'timeout',
] as const

type Cause = (typeof CAUSES)[number]

const task = `This is a reeval project (reeval is an eval runner for coding agents; its CLI is \`reeval\`, already installed, and it runs here without Docker or API keys). Its latest run failed.

Find out why, and fix the project so that \`reeval run\` passes. Fix the cause: don't delete or skip checks, and leave reeval.config.ts alone (it is the agent under test and its judge).

Then write answer.json: {"cause": "<one of ${CAUSES.join(', ')}>", "evidence": "<one sentence>"}.`

/** Each fixture fails for one known reason; `keeps` are what its eval file must still say after the fix. */
const fixtures: Array<{ fixture: string; cause: Cause; file: string; keeps: RegExp[] }> = [
  {
    fixture: 'check-path',
    cause: 'check-path',
    file: 'evals/greet.eval.ts',
    keeps: [/toHaveFile\(\s*'lib\/greet\.js'/, /'Hello, Ada!'/],
  },
  {
    fixture: 'judge-threshold',
    cause: 'judge-threshold',
    file: 'evals/readme.eval.ts',
    keeps: [/c\.judge\(/, /\.toPass\(\)/],
  },
  {
    fixture: 'skill-missing',
    cause: 'skill-missing',
    file: 'evals/greet.eval.ts',
    keeps: [/'Ahoy, Ada!'/],
  },
  {
    fixture: 'flaky-check',
    cause: 'flaky-check',
    file: 'evals/report.eval.ts',
    keeps: [/runs: 6/, /dist\/report\.txt/],
  },
  {
    fixture: 'setup-step',
    cause: 'setup-step',
    file: 'evals/count.eval.ts',
    keeps: [/toBe\('3'\)/],
  },
]

const parseAnswer = (text: string | null): { cause?: unknown } => {
  try {
    return JSON.parse(text ?? '') as { cause?: unknown }
  } catch {
    return {}
  }
}

group('debugs a run', () => {
  for (const { fixture, cause, file, keeps } of fixtures) {
    const { control, variant } = brokenProject(fixture)
    // A study, not a gate: the numbers are each side's pass rate, the lift and the effort.
    const compare = { baseline: control, variants: [variant], gate: 'none' as const }
    evaluate(fixture, { compare }, async (c) => {
      await c.send(task)

      const answer = parseAnswer(await c.readFile('answer.json'))
      expect.soft(answer.cause, 'names the cause').toBe(cause)
      await expect
        .soft(c.exec('node_modules/.bin/reeval run --ui plain'), 'reeval run passes')
        .toSucceed()

      expect.soft(c, 'leaves the agent under test alone').not.toHaveChanged(['reeval.config.ts'])
      const source = (await c.readFile(file)) ?? ''
      const weakened = [
        ...keeps.filter((keep) => !keep.test(source)).map(String),
        ...(source.match(/\.(skip|todo|only)\(|gate:|passRate/g) ?? []),
      ]
      expect.soft(weakened, 'keeps the checks').toEqual([])
    })
  }
})
