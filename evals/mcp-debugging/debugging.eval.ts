import { type AttemptContext, evaluate, expect, group } from 'reeval'
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

const intro =
  'This is a reeval project (reeval is an eval runner for coding agents; its CLI is `reeval`, already installed, and it runs here without Docker or API keys).'

const fixTask = `${intro} Its latest run failed.

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

const parseAnswer = (text: string | null): Record<string, unknown> => {
  try {
    return JSON.parse(text ?? '') as Record<string, unknown>
  } catch {
    return {}
  }
}

/** The toolkit's eval files, by eval name: an answer may name an eval either way. */
const evalFiles: Record<string, string> = {
  'chunks an array': 'chunk.eval.ts',
  'clamps a number': 'clamp.eval.ts',
  'pads a string': 'pad.eval.ts',
  'builds the report': 'report.eval.ts',
  'sums a list': 'sum.eval.ts',
  'title-cases a phrase': 'title-case.eval.ts',
  'removes duplicates': 'uniq.eval.ts',
}

/** The eval names an answer lists, matched loosely: `evals/pad.eval.ts › pads a string` and `pad.eval.ts` name `pads a string`. */
const named = (value: unknown, names: string[]) => {
  const given = Array.isArray(value) ? value.map((g) => String(g).toLowerCase()) : []
  return names.filter((name) =>
    given.some((g) => g.includes(name) || g.includes(evalFiles[name] ?? name)),
  )
}

// A study, not a gate: the numbers are each side's pass rate, the lift and the effort.
const study = (fixture: string, history?: { base: string }) => {
  const { control, variant } = brokenProject(fixture, history)
  return { compare: { baseline: control, variants: [variant], gate: 'none' as const } }
}

group('debugs a run', () => {
  for (const { fixture, cause, file, keeps } of fixtures) {
    evaluate(fixture, study(fixture), async (c) => {
      await c.send(fixTask)

      const answer = parseAnswer(await c.readFile('answer.json'))
      expect(answer.cause, 'names the cause').toBe(cause)
      await expect(
        c.exec('node_modules/.bin/reeval run --ui plain'),
        'reeval run passes',
      ).toSucceed()

      expect(c, 'leaves the agent under test alone').not.toHaveChanged(['reeval.config.ts'])
      const source = (await c.readFile(file)) ?? ''
      const weakened = [
        ...keeps.filter((keep) => !keep.test(source)).map(String),
        ...(source.match(/\.(skip|todo|only)\(|gate:|passRate/g) ?? []),
      ]
      expect(weakened, 'keeps the checks').toEqual([])
    })
  }
})

// Projects with a git history and a recorded run per commit: questions the latest run alone can't
// answer, and one run too big to read whole.
group('reads the history', () => {
  const history = `${intro} Every commit's run is recorded in its history, in evals/.history.`
  const toolkit = { base: 'toolkit' }

  /** Records the agent must leave as they are; new runs it records are fine. */
  const touchedRecords = async (c: AttemptContext) =>
    (await c.exec('git status --porcelain -- evals/.history')).stdout
      .split('\n')
      .filter((line) => line.trim() && !line.startsWith('??'))

  evaluate('flaky-since', study('flaky-since', toolkit), async (c) => {
    await c.send(`${history}

One eval has started failing intermittently. Find which eval, the commit that made it flaky, and whether the flakiness is in the eval's check or in the agent's work. Don't change any files.

Write answer.json: {"eval": "<eval name>", "commit": "<its sha>", "cause": "<check or agent>"}.`)

    const answer = parseAnswer(await c.readFile('answer.json'))
    expect(named([answer.eval], ['builds the report']), 'names the eval').toHaveLength(1)
    const truth = await c.exec(`git log --format=%H --grep='^update evals (batch 5)$'`)
    const given = await c.exec(
      `git rev-parse --verify --quiet '${String(answer.commit ?? '')}^{commit}'`,
    )
    expect(given.stdout.trim(), 'names the commit').toBe(truth.stdout.trim())
    expect(answer.cause, 'names the cause').toBe('check')
    expect(await touchedRecords(c), 'leaves the history alone').toEqual([])
  })

  evaluate('regression', study('regression', toolkit), async (c) => {
    await c.send(`${history}

Compare the run recorded at the tag v1.2 with the latest run. Which evals regressed: passed at v1.2 and fail in the latest run? Don't change any files.

Write answer.json: {"regressed": ["<eval name>", …]}.`)

    const answer = parseAnswer(await c.readFile('answer.json'))
    const regressed = ['pads a string', 'removes duplicates']
    expect(named(answer.regressed, regressed), 'finds each regression').toEqual(regressed)
    expect(
      named(answer.regressed, ['clamps a number', 'chunks an array', 'sums a list']),
      'names nothing else',
    ).toEqual([])
    expect(await touchedRecords(c), 'leaves the history alone').toEqual([])
  })

  evaluate('is-new', study('is-new', toolkit), async (c) => {
    await c.send(`${history}

The latest run failed. Which of its failing evals are failing for the first time in this history, and which failed in earlier runs too? Don't change any files.

Write answer.json: {"new": ["<eval name>", …], "old": ["<eval name>", …]}.`)

    const answer = parseAnswer(await c.readFile('answer.json'))
    const old = ['clamps a number', 'builds the report']
    expect(named(answer.new, ['title-cases a phrase', ...old]), 'finds the new failure').toEqual([
      'title-cases a phrase',
    ])
    expect(named(answer.old, old), 'finds the old failures').toEqual(old)
    expect(await touchedRecords(c), 'leaves the history alone').toEqual([])
  })

  evaluate('big-record', study('big-record', { base: 'catalog' }), async (c) => {
    await c.send(`${fixTask}\n\nIts runs are large: 82 attempts each.`)

    const answer = parseAnswer(await c.readFile('answer.json'))
    expect(answer.cause, 'names the cause').toBe('check-path')
    await expect(c.exec('node_modules/.bin/reeval run --ui plain'), 'reeval run passes').toSucceed()
    expect(c, 'leaves the agent under test alone').not.toHaveChanged(['reeval.config.ts'])
    const source = (await c.readFile('evals/export.eval.ts')) ?? ''
    const weakened = [
      ...[/toHaveFile\(\s*'lib\/export\.js'/, /c\.exec\(joinsRows\)/]
        .filter((keep) => !keep.test(source))
        .map(String),
      ...(source.match(/\.(skip|todo|only)\(|gate:|passRate/g) ?? []),
    ]
    expect(weakened, 'keeps the checks').toEqual([])
  })
})
