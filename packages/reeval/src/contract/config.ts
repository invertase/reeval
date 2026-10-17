// The config's plain-data contract: `ReevalConfig` as `reeval.yaml` or another language carries
// it. Environments are data (`EnvironmentData`), and judge and analysis models are names or fakes
// with fixed answers; AI SDK model objects and fake score functions stay TypeScript only.
// `resolveConfig` checks the config in its own words first; the schema is the backstop for
// anything those checks don't name, and the source of the JSON Schema in schema/plan/.
import { z } from 'zod'
import type {
  AnalysisConfigData,
  Budget,
  CaptureOptions,
  CaptureWindow,
  ConfigJudgeData,
  FakeAnalysisData,
  FakeJudgeData,
  HistoryConfig,
  JSONValue,
  ProfileData,
  ProfileDefaultsData,
  ProfileLimit,
  ReevalConfigData,
} from '../types.ts'
import { environmentDataSchema, sandboxDescriptorSchema } from './environment.ts'
import { harnessDescriptorSchema } from './harness.ts'
import { judgeStateSchema } from './judge.ts'
import { egressPolicySchema, envVarsSchema, gatePolicySchema } from './plain.ts'
import {
  type Assert,
  closest,
  durationSchema,
  fieldPath,
  genericProblem,
  got,
  type Issue,
  oneOf,
  type Same,
  valueAt,
} from './shared.ts'

const count = () => z.number().int().min(1)

export const jsonValueSchema: z.ZodType<JSONValue> = z
  .lazy(() =>
    z.union([
      z.null(),
      z.boolean(),
      z.number(),
      z.string(),
      z.array(jsonValueSchema),
      z.record(z.string(), jsonValueSchema),
    ]),
  )
  .describe('Any JSON value.')

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
    maxConcurrent: count()
      .optional()
      .describe("The most judge calls to this model's provider at once, across the run."),
    state: judgeStateSchema
      .optional()
      .describe(
        "The judge's state: what the judge is given beside the question, not the workspace's or the attempt's state. Merged key by key down the cascade.",
      ),
  })
  .describe('`ConfigJudgeOptions` as data: the model by name, or a fake judge with a fixed score.')

export const captureWindowSchema = z
  .strictObject({
    width: count().describe('In CSS pixels.'),
    height: count().describe('In CSS pixels.'),
  })
  .describe(
    'Live tab size for `c.capture()`. Default 1280×720 when the call and cascade omit `viewport`.',
  )

export const captureOptionsSchema = z
  .strictObject({
    viewport: z
      .union([captureWindowSchema, z.literal('full-page')])
      .optional()
      .describe("The window and saved PNG size, or `'full-page'`. Default 1280×720."),
    timeout: durationSchema
      .optional()
      .describe("How long to poll before failing. Default `'60s'`."),
    browser: z
      .boolean()
      .optional()
      .describe(
        '`false` refuses the host `chrome-headless-shell` binary. `c.capture()` then throws.',
      ),
    model: z
      .string()
      .includes('/')
      .optional()
      .describe(
        'Vision model for `instructions`. Cascades like `question`. Default is the analysis model when that model accepts images; never Jev.',
      ),
  })
  .describe(
    'Camera defaults for `c.capture()`. Cascades config → profile defaults → group → eval, shallow-merged. `viewport` on a level replaces the whole value. `port` is not an option: pass it as the first argument to `c.capture`.',
  )

const harnessList = z.union([harnessDescriptorSchema, z.array(harnessDescriptorSchema).min(1)])

export const budgetSchema = z
  .strictObject({
    attempts: count().optional().describe('The most attempts the plan may have.'),
    duration: durationSchema
      .optional()
      .describe("How long the run may go on, from the first attempt's start."),
  })
  .describe('Run-level caps. `attempts` is checked against the plan; `duration` while running.')

export const historyConfigSchema = z.strictObject({
  dir: z
    .string()
    .optional()
    .describe('Committed history folder (default: `.history` in the directory the evals live in).'),
  artifacts: z
    .enum(['all', 'failures', 'none'])
    .optional()
    .describe("Artifacts recorded next to each run: every eval's, failing evals' only, or none."),
})

const recordMode = z.enum(['manual', 'ci', 'always'])

export const profileDefaultsDataSchema = z
  .strictObject({
    harness: harnessList
      .optional()
      .describe('The agents every eval runs on, unless a group or eval replaces them.'),
    sandbox: sandboxDescriptorSchema
      .optional()
      .describe('The default machine when the resolved environment omits `sandbox`.'),
    environment: environmentDataSchema
      .optional()
      .describe('What every eval runs in when it names no environment.'),
    runs: count().optional().describe('Attempts per cell.'),
    gate: gatePolicySchema.optional().describe("How each cell's attempts decide its outcome."),
    env: envVarsSchema
      .optional()
      .describe("Variables and secrets for the sandbox, merged by name over the config's."),
    egress: egressPolicySchema
      .optional()
      .describe("Where the sandbox may connect; replaces the config's policy."),
    judge: configJudgeDataSchema
      .optional()
      .describe("Defaults for `c.judge()`, merged field by field over the config's."),
    timeout: durationSchema.optional().describe('Per attempt.'),
    capture: captureOptionsSchema
      .optional()
      .describe("Screenshot defaults for `c.capture()`, shallow-merged over the config's."),
  })
  .describe('`ProfileDefaults` as data: the environment without `extend`, and the judge as data.')

export const profileLimitSchema = z
  .strictObject({
    runs: count().optional().describe('The most runs per cell.'),
    compare: z
      .union([z.literal(false), z.strictObject({ maxVariants: z.number().int().min(0) })])
      .optional()
      .describe('`false` runs the control only; `{ maxVariants }` keeps the first n variants.'),
    harness: z
      .array(z.string())
      .optional()
      .describe('Harness ids to allow; evals left with none are skipped.'),
  })
  .describe('Over every eval, and it can only narrow; `pin` on a group or eval skips it.')

export const profileDataSchema = z
  .strictObject({
    defaults: profileDefaultsDataSchema
      .optional()
      .describe("What evals get when they don't say otherwise: under groups and evals."),
    limit: profileLimitSchema
      .optional()
      .describe('Caps over every eval, which only narrow; `pin` on a group or eval skips them.'),
    judge: configJudgeDataSchema
      .optional()
      .describe(
        'Judge settings for this profile, the same as `defaults.judge`, which wins field by field.',
      ),
    budget: budgetSchema.optional().describe("Merged over the config's `budget`."),
    record: recordMode
      .optional()
      .describe("When this profile's runs are copied into the history folder."),
    tags: z
      .array(z.string())
      .optional()
      .describe("Tag filters for this profile, like `--tag` (`'!slow'` excludes)."),
  })
  .describe('`Profile` as data: its defaults and judge as data.')

const fakeVote = z.enum(['A', 'B', 'tie'])
const failure = z.strictObject({ error: z.string() })

export const fakeAnalysisDataSchema = z
  .strictObject({
    kind: z.literal('fake-analysis'),
    output: z.unknown().optional().describe("The model's structured answer."),
    note: z
      .union([z.string(), failure])
      .optional()
      .describe("`analysis.agent`'s note on each eval and harness, or an error to throw."),
    vote: z
      .union([
        fakeVote,
        z.strictObject({ winner: fakeVote, reason: z.string().optional() }),
        failure,
      ])
      .optional()
      .describe(
        'How it answers compare questions: a fixed pick, or `{ error }` to fail every call.',
      ),
  })
  .describe(
    '`fakeAnalysis()` as data: canned answers, without the functions of the digest or pair.',
  )

export const analysisConfigDataSchema = z
  .strictObject({
    model: z
      .union([z.string(), fakeAnalysisDataSchema])
      .optional()
      .describe(
        "`'provider/model'`, e.g. `'google/gemini-3.8-flash'`; default: the judge's, if it's one.",
      ),
    agent: z
      .boolean()
      .optional()
      .describe(
        '`reeval run` writes a note on each eval and harness once its attempts finish, with the analysis model (default false: one call per eval and harness, every run).',
      ),
    instructions: z
      .string()
      .optional()
      .describe(
        'Added to the prompt, e.g. "Fewer tool calls count as a win. The skill under test is reeval-good."',
      ),
    maxInputTokens: z
      .number()
      .int()
      .min(1000)
      .optional()
      .describe(
        "The digest's cap; evidence is dropped, lowest priority first, to fit (default 20000).",
      ),
    maxOutputTokens: z
      .number()
      .int()
      .min(500)
      .optional()
      .describe(
        'The most tokens the model may answer with (default 8000). reeval has no prices, so tokens are the cap.',
      ),
  })
  .describe('`AnalysisConfig` as data: the model by name, or a fake analysis.')

export const reevalConfigDataSchema = z
  .strictObject({
    include: z
      .array(z.string())
      .optional()
      .describe(
        "Globs of eval files, relative to the config's directory; default every `.eval.ts` under `evals`.",
      ),
    harness: harnessList
      .optional()
      .describe(
        'The agents every eval runs on, unless a group or eval replaces them; default Cursor.',
      ),
    sandbox: sandboxDescriptorSchema
      .optional()
      .describe(
        'The default machine when the resolved environment omits `sandbox`. Not an environment: it does not invent skills, files or a name. Implicit `docker()` when nobody sets one.',
      ),
    environment: environmentDataSchema
      .optional()
      .describe(
        "What every eval runs in when it names no environment, and a baseline-less compare's control.",
      ),
    runs: count().optional().describe('Attempts per cell; default 1.'),
    gate: gatePolicySchema
      .optional()
      .describe("How each cell's attempts decide its outcome; default `'all'`."),
    env: envVarsSchema
      .optional()
      .describe('Variables and secrets for the sandbox, merged by name down the cascade.'),
    egress: egressPolicySchema
      .optional()
      .describe("Where the sandbox may connect; default `'allow-all'`."),
    judge: configJudgeDataSchema
      .optional()
      .describe('Defaults for `c.judge()`, merged field by field down the cascade.'),
    timeout: durationSchema.optional().describe("Per attempt; default `'15m'`."),
    capture: captureOptionsSchema
      .optional()
      .describe(
        'Screenshot defaults for `c.capture()`. `REEVAL_CAPTURE_BROWSER=0` refuses the host binary when `c.capture()` runs; it does not change this object.',
      ),
    concurrency: count()
      .optional()
      .describe(
        'How many attempts run at once. `--concurrency` and `REEVAL_CONCURRENCY` override it.',
      ),
    record: recordMode
      .optional()
      .describe(
        'When runs are copied into the history folder: `reeval record` only, in CI, or on every run.',
      ),
    history: historyConfigSchema
      .optional()
      .describe('The history folder, and which attempts keep their artifacts there.'),
    budget: budgetSchema
      .optional()
      .describe("Caps on a run; a profile's `budget` is merged over it."),
    profiles: z
      .record(z.string(), profileDataSchema)
      .optional()
      .describe('Named presets of `defaults`, `limit`, `judge`, `budget`, `record` and `tags`.'),
    defaultProfile: z
      .strictObject({ ci: z.string().optional(), local: z.string().optional() })
      .optional()
      .describe(
        'The profile when neither `--profile` nor `REEVAL_PROFILE` names one: `ci` when `CI` is set.',
      ),
    secrets: z
      .strictObject({ unbrokered: z.enum(['warn', 'error']).optional() })
      .optional()
      .describe(
        "`unbrokered: 'error'` refuses Docker secrets without `hosts` instead of warning (default `'warn'`).",
      ),
    debug: z
      .strictObject({
        keep: count().optional(),
        traceBufferMb: z.number().positive().optional(),
      })
      .optional()
      .describe(
        'Local debug data in `.reeval/debug`: how many runs to keep (default 20), and how many MB of raw trace each attempt buffers for trace.ndjson (default 8; the oldest entries go first).',
      ),
    analysis: analysisConfigDataSchema
      .optional()
      .describe(
        "`reeval analyze`, compare questions without a model, and `agent`'s notes during a run.",
      ),
  })
  .describe(
    '`ReevalConfig` in its data forms, as `reeval.yaml` or another language carries it: the environment without `extend`, judge and analysis models by name or as fakes with fixed answers, and profiles the same way. AI SDK model objects and fake score functions are TypeScript only.',
  )

export type _SameAsSchema = [
  Assert<Same<z.infer<typeof jsonValueSchema>, JSONValue>>,
  Assert<Same<z.infer<typeof fakeJudgeDataSchema>, FakeJudgeData>>,
  Assert<Same<z.infer<typeof configJudgeDataSchema>, ConfigJudgeData>>,
  Assert<Same<keyof z.infer<typeof configJudgeDataSchema>, keyof ConfigJudgeData>>,
  Assert<Same<z.infer<typeof captureWindowSchema>, CaptureWindow>>,
  Assert<Same<z.infer<typeof captureOptionsSchema>, CaptureOptions>>,
  Assert<Same<z.infer<typeof budgetSchema>, Budget>>,
  Assert<Same<z.infer<typeof historyConfigSchema>, HistoryConfig>>,
  Assert<Same<z.infer<typeof profileDefaultsDataSchema>, ProfileDefaultsData>>,
  Assert<Same<keyof z.infer<typeof profileDefaultsDataSchema>, keyof ProfileDefaultsData>>,
  Assert<Same<z.infer<typeof profileLimitSchema>, ProfileLimit>>,
  Assert<Same<z.infer<typeof profileDataSchema>, ProfileData>>,
  Assert<Same<keyof z.infer<typeof profileDataSchema>, keyof ProfileData>>,
  Assert<Same<z.infer<typeof fakeAnalysisDataSchema>, FakeAnalysisData>>,
  Assert<Same<z.infer<typeof analysisConfigDataSchema>, AnalysisConfigData>>,
  Assert<Same<z.infer<typeof reevalConfigDataSchema>, ReevalConfigData>>,
  Assert<Same<keyof z.infer<typeof reevalConfigDataSchema>, keyof ReevalConfigData>>,
]

/** The object schema an issue's path leads to through `schema`, for "Did you mean". */
function keysAt(schema: z.ZodType, path: readonly PropertyKey[], value: unknown): string[] {
  const def = schema.def as {
    type: string
    shape?: Record<string, z.ZodType>
    innerType?: z.ZodType
    valueType?: z.ZodType
    element?: z.ZodType
    options?: z.ZodType[]
    getter?: () => z.ZodType
  }
  if (def.innerType) return keysAt(def.innerType, path, value)
  if (def.getter) return keysAt(def.getter(), path, value)
  if (def.options) {
    return [...new Set(def.options.flatMap((option) => keysAt(option, path, value)))]
  }
  const [key, ...rest] = path
  if (key === undefined) return def.shape ? Object.keys(def.shape) : []
  const next = valueAt(value, [key])
  if (def.shape) {
    const field = def.shape[String(key)]
    return field ? keysAt(field, rest, next) : []
  }
  const inner = def.valueType ?? def.element
  return inner ? keysAt(inner, rest, next) : []
}

/**
 * The issue under a union that went furthest into the value: the branch the value was most
 * likely meant to be. A union where every branch failed at its own path is left as it is.
 */
function deepest(issue: Issue): Issue {
  if (issue.code !== 'invalid_union' || !('errors' in issue) || !issue.errors.length) return issue
  let best: Issue | undefined
  for (const branch of issue.errors) {
    const inner = branch[0]
    if (!inner) continue
    const found = deepest({ ...inner, path: [...issue.path, ...inner.path] } as Issue)
    if (!best || found.path.length > best.path.length) best = found
  }
  return best && best.path.length > issue.path.length ? best : issue
}

/**
 * reeval's sentence for what the config contract refuses in `value` (the parsed `reeval.yaml`,
 * or a config another language sent), naming the field by its path, or undefined.
 */
export function configDataProblem(value: unknown, file: string): string | undefined {
  const result = reevalConfigDataSchema.safeParse(value)
  if (result.success) return undefined
  const { issues } = result.error
  const first = issues.find((i) => i.code === 'unrecognized_keys') ?? (issues[0] as Issue)
  const issue = deepest(first)
  const field = fieldPath(issue.path)
  const at = field ? `${field} in ${file}` : file
  const v = valueAt(value, issue.path)
  if (issue.code === 'unrecognized_keys') {
    const key = issue.keys[0] as string
    const near = closest(key, keysAt(reevalConfigDataSchema, issue.path, value))
    const hint = near ? ` Did you mean "${near}"?` : ''
    return `Unknown option "${key}" in ${at}.${hint}`
  }
  if (issue.code === 'invalid_union') {
    const values = 'options' in issue ? (issue.options as unknown[]) : undefined
    return values
      ? `${at} is ${oneOf(values)} (got ${got(v)})`
      : `${at} matches none of its forms (got ${got(v)})`
  }
  if (issue.code === 'invalid_type' && v === undefined) return `${at} is missing`
  if ((issue.code === 'too_small' || issue.code === 'too_big') && issue.origin === 'number') {
    const small = issue.code === 'too_small'
    const bound = small ? issue.minimum : issue.maximum
    const strict = small ? 'above' : 'below'
    const word = issue.inclusive === false ? strict : small ? 'at least' : 'at most'
    return `${at} must be ${word} ${String(bound)} (got ${got(v)})`
  }
  return `${at}${genericProblem('', { ...issue, path: [] } as Issue, v)}`
}
