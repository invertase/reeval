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
  FakeAnalysisData,
  HistoryConfig,
  ProfileData,
  ProfileDefaultsData,
  ProfileLimit,
  ReevalConfigData,
} from '../types.ts'
import { environmentDataSchema, sandboxDescriptorSchema } from './environment.ts'
import { gatewayEntryDataSchema } from './gateway.ts'
import { harnessDescriptorSchema } from './harness.ts'
import { configJudgeDataSchema } from './judge.ts'
import { egressPolicySchema, envVarsSchema, gatePolicySchema } from './plain.ts'
import { questionOptionsSchema } from './questions.ts'
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

/** `runs`: a count, or `{ bestOf }` with an odd count of 3 or more. */
const runs = () =>
  z.union([
    count(),
    z.strictObject({
      bestOf: z
        .number()
        .int()
        .min(3)
        .refine((n) => n % 2 === 1, 'must be odd'),
    }),
  ])

export const captureWindowSchema = z.strictObject({
  width: count(),
  height: count(),
})

export const captureOptionsSchema = z.strictObject({
  viewport: z.union([captureWindowSchema, z.literal('full-page')]).optional(),
  timeout: durationSchema.optional(),
  browser: z.boolean().optional(),
  model: z.string().includes('/').optional(),
})

const harnessList = z.union([harnessDescriptorSchema, z.array(harnessDescriptorSchema).min(1)])

export const budgetSchema = z.strictObject({
  attempts: count().optional(),
  duration: durationSchema.optional(),
})

export const historyConfigSchema = z.strictObject({
  dir: z.string().optional(),
  artifacts: z.enum(['all', 'failures', 'none']).optional(),
})

const recordMode = z.enum(['manual', 'ci', 'always'])

export const profileDefaultsDataSchema = z.strictObject({
  harness: harnessList.optional(),
  sandbox: sandboxDescriptorSchema.optional(),
  environment: environmentDataSchema.optional(),
  runs: runs().optional(),
  gate: gatePolicySchema.optional(),
  env: envVarsSchema.optional(),
  egress: egressPolicySchema.optional(),
  judge: configJudgeDataSchema.optional(),
  timeout: durationSchema.optional(),
  capture: captureOptionsSchema.optional(),
  question: questionOptionsSchema.optional(),
})

export const profileLimitSchema = z.strictObject({
  runs: count().optional(),
  compare: z
    .union([z.literal(false), z.strictObject({ maxVariants: z.number().int().min(0) })])
    .optional(),
  harness: z.array(z.string()).optional(),
})

export const profileDataSchema = z.strictObject({
  defaults: profileDefaultsDataSchema.optional(),
  limit: profileLimitSchema.optional(),
  judge: configJudgeDataSchema.optional(),
  budget: budgetSchema.optional(),
  record: recordMode.optional(),
  tags: z.array(z.string()).optional(),
  gateway: z.array(gatewayEntryDataSchema).min(1).optional(),
})

const fakeVote = z.enum(['A', 'B', 'tie'])
const failure = z.strictObject({ error: z.string() })

export const fakeAnalysisDataSchema = z.strictObject({
  kind: z.literal('fake-analysis'),
  output: z.unknown().optional(),
  vote: z
    .union([fakeVote, z.strictObject({ winner: fakeVote, reason: z.string().optional() }), failure])
    .optional(),
  answer: z
    .union([
      z.string(),
      z.strictObject({ choice: z.string().optional(), text: z.string().optional() }),
      failure,
    ])
    .optional(),
})

export const analysisConfigDataSchema = z.strictObject({
  model: z.union([z.string(), fakeAnalysisDataSchema]).optional(),
  instructions: z.string().optional(),
  maxInputTokens: z.number().int().min(1000).optional(),
  maxOutputTokens: z.number().int().min(500).optional(),
})

export const reevalConfigDataSchema = z.strictObject({
  include: z.array(z.string()).optional(),
  harness: harnessList.optional(),
  sandbox: sandboxDescriptorSchema.optional(),
  environment: environmentDataSchema.optional(),
  runs: runs().optional(),
  gate: gatePolicySchema.optional(),
  env: envVarsSchema.optional(),
  egress: egressPolicySchema.optional(),
  judge: configJudgeDataSchema.optional(),
  timeout: durationSchema.optional(),
  capture: captureOptionsSchema.optional(),
  question: questionOptionsSchema.optional(),
  concurrency: count().optional(),
  record: recordMode.optional(),
  history: historyConfigSchema.optional(),
  budget: budgetSchema.optional(),
  profiles: z.record(z.string(), profileDataSchema).optional(),
  defaultProfile: z
    .strictObject({ ci: z.string().optional(), local: z.string().optional() })
    .optional(),
  secrets: z.strictObject({ unbrokered: z.enum(['warn', 'error']).optional() }).optional(),
  debug: z
    .strictObject({
      keep: count().optional(),
      traceBufferMb: z.number().positive().optional(),
    })
    .optional(),
  analysis: analysisConfigDataSchema.optional(),
  gateway: z.array(gatewayEntryDataSchema).min(1).optional(),
})

export type _SameAsSchema = [
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
