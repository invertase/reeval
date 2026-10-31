// The judge options' contract: the model, threshold, provider options and concurrency, and
// `c.judge()`'s inputs (what one call shows the judge beside the question). Their data form is the
// config's (a model by name or a fake judge); groups, evals and `c.judge()` also take an AI SDK
// model object, which only TypeScript can hold, so the authored schemas accept any model and the
// cascade checks it later.
import { z } from 'zod'
import { badJudgeArtifacts } from '../judge/artifacts.ts'
import { checkModelString } from '../judge/index.ts'
import type {
  Capture,
  ConfigJudgeData,
  FakeJudgeData,
  JSONValue,
  JudgeCallFields,
  JudgeInputs,
  JudgeModel,
  JudgeOptions,
  JudgeSubject,
  Turn,
} from '../types.ts'
import { GATEWAY_NAMES, gatewayDescriptorSchema, gatewayNameSchema } from './gateway.ts'
import { type Assert, type Issue, jsonValueSchema, nonEmpty, type Same } from './shared.ts'

/** The inputs every judge call and question shares; `c.judge()` adds `contents` and its own `artifacts`. */
export const sharedInputFields = {
  task: z.boolean().optional(),
  output: z.boolean().optional(),
  files: z.boolean().optional(),
  diff: z.union([z.boolean(), z.array(nonEmpty()).min(1)]).optional(),
  transcript: z.union([z.boolean(), z.enum(['tools', 'full'])]).optional(),
  checks: z.union([z.boolean(), z.array(nonEmpty())]).optional(),
  observations: z.union([z.boolean(), z.array(nonEmpty())]).optional(),
}

export const turnsSchema = z.enum(['last', 'all'])

const { task, output, files, diff, transcript, checks, observations } = sharedInputFields

export const judgeInputsSchema = z.strictObject({
  task,
  output,
  files,
  diff,
  contents: z.array(nonEmpty()).optional(),
  transcript,
  checks,
  observations,
  artifacts: z.union([z.literal(true), z.array(z.custom<Capture | string>())]).optional(),
})

const judgeSubjectSchema = z.strictObject({
  on: z.custom<Turn | JSONValue>().optional(),
  turns: turnsSchema.optional(),
})

export const INPUT_KEYS = Object.keys(judgeInputsSchema.shape) as Array<keyof JudgeInputs>

/** True when an input's value turns it on: not `false`, unset or an empty list. */
export const inputOn = (value: unknown): boolean =>
  value !== undefined && value !== false && !(Array.isArray(value) && value.length === 0)

/** The input keys an options object turns on, in `keys`' order. */
export const inputsOn = (value: Record<string, unknown>, keys: readonly string[]): string[] =>
  keys.filter((k) => inputOn(value[k]))

/** `a`, `b` and `c` as prose: "a, b or c". */
export const orList = (items: readonly string[]): string =>
  items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`

export const NO_JUDGE_INPUT = `c.judge() shows the judge nothing: turn on at least one input, such as { diff: true } or { contents: ['src/**'] }. The inputs are ${orList(INPUT_KEYS)}.`

export const judgeFields = {
  threshold: z
    .number()
    .min(0, 'must be between 0 and 1')
    .max(1, 'must be between 0 and 1')
    .optional(),
  providerOptions: z.record(z.string(), z.record(z.string(), jsonValueSchema)).optional(),
  maxConcurrent: z.number().int().min(1).optional(),
  gateway: z.union([gatewayNameSchema, gatewayDescriptorSchema]).optional(),
}

export const fakeJudgeDataSchema = z.strictObject({
  kind: z.literal('fake-judge'),
  score: z.number().min(0).max(1),
})

export const judgeModelNameSchema = z
  .string()
  .regex(/\//, "must be a 'provider/model' string, e.g. 'google/gemini-3.8-flash'")

export const configJudgeDataSchema = z.strictObject({
  model: z.union([z.string(), fakeJudgeDataSchema]).optional(),
  ...judgeFields,
})

export const judgeOptionsSchema = z.strictObject({
  model: z.custom<JudgeModel>().optional(),
  ...judgeFields,
})

export const judgeCallSchema = judgeOptionsSchema
  .extend(judgeInputsSchema.shape)
  .extend(judgeSubjectSchema.shape)

export type _SameAsSchema = [
  Assert<Same<z.infer<typeof judgeInputsSchema>, JudgeInputs>>,
  Assert<Same<keyof z.infer<typeof judgeInputsSchema>, keyof JudgeInputs>>,
  Assert<Same<z.infer<typeof judgeSubjectSchema>, JudgeSubject>>,
  Assert<Same<z.infer<typeof fakeJudgeDataSchema>, FakeJudgeData>>,
  Assert<Same<z.infer<typeof configJudgeDataSchema>, ConfigJudgeData>>,
  Assert<Same<keyof z.infer<typeof configJudgeDataSchema>, keyof ConfigJudgeData>>,
  Assert<Same<z.infer<typeof judgeOptionsSchema>, JudgeOptions>>,
  Assert<Same<keyof z.infer<typeof judgeOptionsSchema>, keyof JudgeOptions>>,
  Assert<Same<z.infer<typeof judgeCallSchema>, JudgeCallFields>>,
  Assert<Same<keyof z.infer<typeof judgeCallSchema>, keyof JudgeCallFields>>,
]

const CALL_ONLY_KEYS = [...INPUT_KEYS, 'on', 'turns']

/**
 * Where judge options are checked, which decides the sentence: an eval's or group's options
 * (`where` names them), the config or a profile (`path` is `judge` or `profiles.<name>.judge` in
 * `file`), or `c.judge()`.
 */
export type JudgeSite =
  | { at: 'options'; where: string }
  | { at: 'config'; path: string; file: string }
  | { at: 'call' }

const VALUES: Record<Exclude<keyof JudgeInputs, 'artifacts'> | 'turns', string> = {
  task: 'true or false',
  output: 'true or false',
  files: 'true or false',
  diff: 'true, false or a non-empty list of patterns',
  contents: 'a list of paths or patterns',
  transcript: "true, false, 'tools' or 'full'",
  turns: "'last' or 'all'",
  checks: 'true, false or a list of commands',
  observations: 'true, false or a list of names',
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
  /** A judge field and where it was set: `judge.threshold in evals/a.eval.ts › e`. */
  const field = (key?: string) => {
    if (site.at === 'call') return `c.judge() ${key ?? 'options'}`
    const base = site.at === 'config' ? site.path : 'judge'
    return `${key ? `${base}.${key}` : base} in ${site.at === 'config' ? site.file : site.where}`
  }
  const loc =
    site.at === 'call'
      ? ' in c.judge()'
      : site.at === 'options'
        ? ` in ${site.where}`
        : ` in ${site.path === 'judge' ? '' : `${site.path.replace(/\.judge$/, '')} in `}${site.file}`
  if (typeof judge !== 'object' || judge === null || Array.isArray(judge)) {
    const example = site.at === 'call' ? '{ diff: true }' : '{ threshold: 0.8 }'
    return `${field()} must be an object such as ${example} (got ${shown(judge)})`
  }
  const value = judge as Record<string, unknown>
  const model = value.model as { kind?: unknown; score?: unknown } | string | null | undefined
  if (site.at === 'config' && typeof model === 'string') {
    const problem = checkModelString(model, field('model'))
    if (problem) return problem
  }
  const schema =
    site.at === 'call'
      ? judgeCallSchema
      : site.at === 'config'
        ? configJudgeDataSchema
        : judgeOptionsSchema
  const parsed = schema.safeParse(judge)
  if (parsed.success) {
    return site.at === 'call' && !inputsOn(value, INPUT_KEYS).length ? NO_JUDGE_INPUT : undefined
  }
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
      return `${field('model')} must be fakeJudge({ score }) with a number. Pass a score function per group, eval or call instead.`
    }
    return `${field('model')} must be a "provider/model" string or fakeJudge(). Pass a model object per group, eval or call instead.`
  }
  const maxConcurrentProblem = () => {
    if (site.at === 'config' || !at('maxConcurrent')) return undefined
    return `${field('maxConcurrent')} must be a whole number of at least 1 (got ${shown(value.maxConcurrent)})`
  }
  const thresholdProblem = () => {
    if (!at('threshold')) return undefined
    return `${field('threshold')} must be between 0 and 1 (got ${shown(value.threshold)})`
  }
  const keyProblem = () => {
    const key = issues.find((i) => i.code === 'unrecognized_keys' && i.path.length === 0)
    const name = (key as (Issue & { keys: string[] }) | undefined)?.keys[0]
    if (name === undefined) return undefined
    const allowed = Object.keys(schema.shape)
    const hint = nearest(name, allowed)
    const why =
      site.at !== 'call' && CALL_ONLY_KEYS.includes(name)
        ? ` ${name} is per call: c.judge(question, { ${name} }).`
        : hint
          ? ` Did you mean "${hint}"?`
          : ''
    return `Unknown judge option "${name}"${loc}.${why}`
  }
  const inputProblem = () => {
    const issue = issues.find((i) => typeof i.path[0] === 'string' && i.path[0] in VALUES)
    if (!issue) return undefined
    const key = issue.path[0] as keyof typeof VALUES
    return `${field(key)} must be ${VALUES[key]} (got ${shown(value[key])})`
  }
  const providerOptionsProblem = () =>
    at('providerOptions')
      ? `${field('providerOptions')} must map each provider to an object of JSON values, e.g. { google: { thinkingConfig: { thinkingBudget: 0 } } } (got ${shown(value.providerOptions)})`
      : undefined
  const artifactsProblem = () =>
    at('artifacts') ? `c.judge() artifacts ${badJudgeArtifacts(value.artifacts)}` : undefined
  const gatewayProblem = () =>
    at('gateway')
      ? `${field('gateway')} names a gateway in the config's gateway list: ${GATEWAY_NAMES.map((g) => `'${g}'`).join(' or ')}, or is its helper (got ${shown(value.gateway)})`
      : undefined
  if (site.at === 'config') {
    order.push(modelProblem, keyProblem, providerOptionsProblem, thresholdProblem, gatewayProblem)
  } else if (site.at === 'call') {
    order.push(
      thresholdProblem,
      maxConcurrentProblem,
      keyProblem,
      inputProblem,
      providerOptionsProblem,
      artifactsProblem,
      gatewayProblem,
    )
  } else {
    order.push(
      maxConcurrentProblem,
      thresholdProblem,
      keyProblem,
      providerOptionsProblem,
      gatewayProblem,
    )
  }
  for (const check of order) {
    const problem = check()
    if (problem) return problem
  }
  return `judge options${loc} aren't valid: ${issues[0]?.message ?? 'unknown problem'}`
}
