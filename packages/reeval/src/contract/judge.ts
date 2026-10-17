// The judge options' contract: `state` (what the judge is given beside the question), the model,
// threshold, provider options and concurrency. Their data form is the config's (a model by name or
// a fake judge); groups, evals and `c.judge()` also take an AI SDK model object, which only
// TypeScript can hold, so the authored schemas accept any model and the cascade checks it later.
import { z } from 'zod'
import { badJudgeArtifacts } from '../judge/artifacts.ts'
import { checkModelString } from '../judge/index.ts'
import type {
  Capture,
  ConfigJudgeData,
  FakeJudgeData,
  JSONValue,
  JudgeCallOptions,
  JudgeModel,
  JudgeOptions,
  JudgeStateOptions,
  Turn,
} from '../types.ts'
import { type Assert, type Issue, jsonValueSchema, nonEmpty, type Same } from './shared.ts'

export const judgeStateSchema = z
  .strictObject({
    task: z.boolean().optional().describe("The graded turn's prompt. Default true."),
    output: z
      .boolean()
      .optional()
      .describe("The graded turn's final message, or `on`'s value. Default true."),
    files: z
      .boolean()
      .optional()
      .describe(
        "`status path` lines for the changed files, under `diff`'s patterns. Default true.",
      ),
    diff: z
      .union([z.boolean(), z.array(nonEmpty()).min(1)])
      .optional()
      .describe(
        'The diff since the eval started. A list is gitignore-style patterns over workspace paths: the last matching pattern wins and `!` excludes. Default true.',
      ),
    contents: z
      .array(nonEmpty())
      .optional()
      .describe(
        "Workspace files shown whole, as they are now, changed or not: exact paths or gitignore-style patterns (`'**'`, `'src/**'`; the last match wins, `!` excludes) over the files git sees in the workspace. A missing exact path is `null`; a pattern that matches nothing adds nothing. These files leave the diff. Default none.",
      ),
    transcript: z
      .union([z.boolean(), z.enum(['tools', 'full'])])
      .optional()
      .describe(
        "The graded turn's transcript as text lines: `true` is messages and tool calls with tool output clipped, `'tools'` tool calls only, `'full'` adds reasoning and whole tool output. Default false.",
      ),
    turns: z
      .enum(['last', 'all'])
      .optional()
      .describe(
        "`'all'`: every turn up to the graded one under `turns`, each with its task, output and (with `transcript`) transcript. Default `'last'`.",
      ),
    checks: z
      .union([z.boolean(), z.array(nonEmpty())])
      .optional()
      .describe(
        '`c.exec` results so far; a list shows only those commands, as passed to `c.exec`. Default false.',
      ),
  })
  .describe(
    'What the judge is given: each key is a key of the state in `judge-input.json`. An unset key keeps its default, which is what the judge gets with no `state` option at all.',
  )

export const judgeFields = {
  threshold: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Minimum score (0–1) for a `pass` verdict.'),
  providerOptions: z
    .record(z.string(), z.record(z.string(), jsonValueSchema))
    .optional()
    .describe("AI SDK provider options for the judge's calls, keyed by provider."),
  maxConcurrent: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("The most judge calls to this model's provider at once, across the run."),
  state: judgeStateSchema
    .optional()
    .describe(
      "The judge's state: what the judge is given beside the question, not the workspace's or the attempt's state. Merged key by key down the cascade.",
    ),
}

export const fakeJudgeDataSchema = z
  .strictObject({
    kind: z.literal('fake-judge'),
    score: z.number().min(0).max(1).describe('The score (0–1) every call gets.'),
  })
  .describe('`fakeJudge()` as data: the score every call gets.')

export const configJudgeDataSchema = z
  .strictObject({
    model: z
      .union([z.string(), fakeJudgeDataSchema])
      .optional()
      .describe("`'provider/model'`, or a fake judge."),
    ...judgeFields,
  })
  .describe('`ConfigJudgeOptions` as data: the model by name, or a fake judge with a fixed score.')

export const judgeOptionsSchema = z.strictObject({
  model: z.custom<JudgeModel>().optional(),
  ...judgeFields,
})

export const judgeCallSchema = judgeOptionsSchema.extend({
  on: z.custom<Turn | JSONValue>().optional(),
  artifacts: z.array(z.custom<Capture | string>()).optional(),
})

export type _SameAsSchema = [
  Assert<Same<z.infer<typeof judgeStateSchema>, JudgeStateOptions>>,
  Assert<Same<keyof z.infer<typeof judgeStateSchema>, keyof JudgeStateOptions>>,
  Assert<Same<z.infer<typeof fakeJudgeDataSchema>, FakeJudgeData>>,
  Assert<Same<z.infer<typeof configJudgeDataSchema>, ConfigJudgeData>>,
  Assert<Same<keyof z.infer<typeof configJudgeDataSchema>, keyof ConfigJudgeData>>,
  Assert<Same<z.infer<typeof judgeOptionsSchema>, JudgeOptions>>,
  Assert<Same<keyof z.infer<typeof judgeOptionsSchema>, keyof JudgeOptions>>,
  Assert<Same<z.infer<typeof judgeCallSchema>, JudgeCallOptions>>,
  Assert<Same<keyof z.infer<typeof judgeCallSchema>, keyof JudgeCallOptions>>,
]

export const STATE_KEYS = Object.keys(judgeStateSchema.shape) as Array<keyof JudgeStateOptions>

/**
 * Where judge options are checked, which decides the sentence: an eval's or group's options
 * (`where` names them), the config or a profile (`where` is e.g. `config.judge`), or `c.judge()`.
 */
export type JudgeSite =
  | { at: 'options'; where: string }
  | { at: 'config'; where: string }
  | { at: 'call' }

const JUDGE_HINTS: Record<string, string> = {
  include: 'state.diff',
  exclude: 'state.diff',
  files: 'state.contents',
  contents: 'state.contents',
  transcript: 'state.transcript',
  see: 'state',
  shows: 'state',
  show: 'state',
  input: 'state',
}

const VALUES: Record<keyof JudgeStateOptions, string> = {
  task: 'true or false',
  output: 'true or false',
  files: 'true or false',
  diff: 'true, false or a non-empty list of patterns',
  contents: 'a list of paths or patterns',
  transcript: "true, false, 'tools' or 'full'",
  turns: "'last' or 'all'",
  checks: 'true, false or a list of commands',
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0] ?? 0
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const here = row[j] ?? 0
      row[j] = Math.min(here + 1, (row[j - 1] ?? 0) + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = here
    }
  }
  return row[b.length] ?? 0
}

const nearest = (key: string, keys: readonly string[]) =>
  keys.find((k) => distance(key.toLowerCase(), k.toLowerCase()) <= 2)

const shown = (value: unknown) => JSON.stringify(value) ?? String(value)

/**
 * The first problem with a judge options object, as one sentence, or undefined. The checks run in
 * the order each site has always run them, so a value with several problems names the same one.
 */
export function judgeProblem(judge: unknown, site: JudgeSite): string | undefined {
  const loc = site.at === 'call' ? ' in c.judge()' : ` in ${site.where}`
  if (typeof judge !== 'object' || judge === null || Array.isArray(judge)) {
    return `judge must be an object such as { threshold: 0.8 } (got ${shown(judge)})${loc}`
  }
  const value = judge as Record<string, unknown>
  const model = value.model as { kind?: unknown; score?: unknown } | string | null | undefined
  if (site.at === 'config' && typeof model === 'string') {
    const problem = checkModelString(model)
    if (problem) return `${site.where}: ${problem}`
  }
  const schema =
    site.at === 'call'
      ? judgeCallSchema
      : site.at === 'config'
        ? configJudgeDataSchema
        : judgeOptionsSchema
  const parsed = schema.safeParse(judge)
  if (parsed.success) return undefined
  // The rest of a numeric fake judge (its score's range, a stray key) is left to the config's data
  // check, which names the file it's in.
  const numericFake =
    site.at === 'config' &&
    typeof model === 'object' &&
    model?.kind === 'fake-judge' &&
    typeof model.score === 'number'
  const issues = parsed.error.issues.filter((i) => !(numericFake && i.path[0] === 'model'))
  if (!issues.length) return undefined
  const at = (key: string) => issues.some((i) => i.path[0] === key)
  const order: Array<() => string | undefined> = []
  const modelProblem = () => {
    if (site.at !== 'config' || !at('model')) return undefined
    if (typeof model === 'object' && model?.kind === 'fake-judge') {
      return `${site.where}.model: fakeJudge({ score }) in the config takes a number. Pass a score function per group, eval or call instead.`
    }
    return `${site.where}.model must be a "provider/model" string or fakeJudge(). Pass model objects per group, eval or call instead.`
  }
  const maxConcurrentProblem = () => {
    if (site.at === 'config' || !at('maxConcurrent')) return undefined
    const got = String(value.maxConcurrent)
    return site.at === 'call'
      ? `c.judge() maxConcurrent must be a whole number of at least 1 (got ${got})`
      : `maxConcurrent must be a whole number of at least 1 (got ${got}) for judge in ${site.where}`
  }
  const thresholdProblem = () => {
    if (!at('threshold')) return undefined
    const got = String(value.threshold)
    if (site.at === 'call') return `c.judge() threshold must be between 0 and 1 (got ${got})`
    if (site.at === 'config') return `${site.where}.threshold must be between 0 and 1`
    return `judge.threshold must be between 0 and 1 (got ${got}) in ${site.where}`
  }
  const keyProblem = () => {
    const key = issues.find((i) => i.code === 'unrecognized_keys' && i.path.length === 0)
    const name = (key as (Issue & { keys: string[] }) | undefined)?.keys[0]
    if (name === undefined) return undefined
    const allowed = Object.keys(schema.shape)
    const hint = JUDGE_HINTS[name] ?? nearest(name, allowed)
    const why =
      site.at !== 'call' && (name === 'on' || name === 'artifacts')
        ? ` ${name} is per call: c.judge(question, { ${name} }).`
        : hint
          ? ` Did you mean "${hint}"?`
          : ''
    return `Unknown judge option "${name}"${loc}.${why}`
  }
  const stateProblem = () => {
    const issue = issues.find((i) => i.path[0] === 'state')
    if (!issue) return undefined
    const { state } = value
    if (typeof state !== 'object' || state === null || Array.isArray(state)) {
      return `judge.state must be an object such as { transcript: 'tools' } (got ${shown(state)})${loc}`
    }
    if (issue.code === 'unrecognized_keys' && issue.path.length === 1) {
      const key = issue.keys[0] ?? ''
      const hint = nearest(key, STATE_KEYS)
      return `Unknown judge.state key "${key}"${loc}.${hint ? ` Did you mean "${hint}"?` : ''}`
    }
    const key = issue.path[1] as keyof JudgeStateOptions
    return `judge.state.${key} must be ${VALUES[key]} (got ${shown((state as JudgeStateOptions)[key])})${loc}`
  }
  const providerOptionsProblem = () =>
    at('providerOptions')
      ? `judge.providerOptions maps each provider to an object of JSON values, e.g. { google: { thinkingConfig: { thinkingBudget: 0 } } } (got ${shown(value.providerOptions)})${loc}`
      : undefined
  const artifactsProblem = () =>
    at('artifacts') ? `c.judge() artifacts ${badJudgeArtifacts(value.artifacts)}` : undefined
  if (site.at === 'config') {
    order.push(modelProblem, keyProblem, stateProblem, providerOptionsProblem, thresholdProblem)
  } else if (site.at === 'call') {
    order.push(
      thresholdProblem,
      maxConcurrentProblem,
      keyProblem,
      stateProblem,
      providerOptionsProblem,
      artifactsProblem,
    )
  } else {
    order.push(
      maxConcurrentProblem,
      thresholdProblem,
      keyProblem,
      stateProblem,
      providerOptionsProblem,
    )
  }
  for (const check of order) {
    const problem = check()
    if (problem) return problem
  }
  return `judge options${loc} are not valid: ${issues[0]?.message ?? 'unknown problem'}`
}
