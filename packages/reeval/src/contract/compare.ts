// The compare option's plain-data contract: its questions, the factors they vary, and the compare
// object itself. Environments in it are checked by whichever schema the caller passes (an
// `Environment` from `defineEnvironment`, or environment data from another language).
import { z } from 'zod'
import type {
  CompareGate,
  CompareOptions,
  CompareQuestion,
  Environment,
  HarnessDescriptor,
  PairFactor,
} from '../types.ts'
import { FACTORY, harnessDescriptorSchema, harnessProblem } from './harness.ts'
import { type Assert, type Issue, nonEmpty, refusal, type Same } from './shared.ts'

export const pairFactorSchema = z
  .enum(['environment', 'harness'])
  .describe('A matrix factor a compare question varies when pairing; the others are held.')

export const compareGateSchema = z.enum(['variants', 'all', 'none'])

/** Evaluation models score yes/no questions only, so they can't pick between two attempts. */
export const isEvaluationModel = (model: string) => model.startsWith('typesafe-ai/')

const questionObjectSchema = z.strictObject({
  question: nonEmpty(),
  model: z
    .string()
    .refine((m) => m.includes('/'), { params: { provider: true } })
    .refine((m) => !isEvaluationModel(m), { params: { evaluation: true } })
    .optional()
    .describe("`'provider/model'` that answers it."),
  across: pairFactorSchema.optional().describe('The factor it varies when pairing.'),
})

export const compareQuestionSchema = z
  .union([nonEmpty(), questionObjectSchema])
  .describe(
    "A question for pairwise judgement: its text, or the text and the `'provider/model'` that answers it. Without a model, `analysis.model` answers, else the judge's when it's a language model. `across` is the factor it varies when pairing; without it (and without a one-factor `compare.across`) both pair kinds run.",
  )

/** The first label two items share. */
const twice = (labels: unknown[]) => labels.find((k, i) => labels.indexOf(k) !== i)

function unique(label: (item: unknown) => unknown) {
  return (list: unknown[], ctx: z.RefinementCtx) => {
    if (twice(list.map(label)) !== undefined) ctx.addIssue({ code: 'custom', message: 'twice' })
  }
}

const questionText = (q: unknown) =>
  typeof q === 'string' ? q : (q as { question: string }).question

/** The compare object, with environments checked by `environment`. */
export const compareSchema = <E extends z.ZodType>(environment: E) =>
  z.strictObject({
    baseline: environment.optional(),
    variants: z.array(environment).min(1),
    gate: compareGateSchema.optional(),
    minLift: z.number().min(-1).max(1).optional(),
    harness: z.array(z.union([z.string(), harnessDescriptorSchema])).optional(),
    questions: z.array(compareQuestionSchema).min(1).superRefine(unique(questionText)).optional(),
    across: z
      .union([pairFactorSchema, z.array(pairFactorSchema).min(1).superRefine(unique(String))])
      .optional(),
  })

const authoredCompare = compareSchema(z.custom<Environment>())

export type _SameAsSchema = [
  Assert<Same<z.infer<typeof pairFactorSchema>, PairFactor>>,
  Assert<Same<z.infer<typeof compareGateSchema>, CompareGate>>,
  Assert<Same<z.infer<typeof compareQuestionSchema>, CompareQuestion>>,
  Assert<Same<z.infer<typeof authoredCompare>, CompareOptions<Environment>>>,
  Assert<Same<keyof z.infer<typeof authoredCompare>, keyof CompareOptions<Environment>>>,
]

const QUESTION_EXAMPLE = `questions: ['Which handles state more cleanly?']`
const ACROSS_HINT = `'environment' (vary the environment, same harness) or 'harness' (vary the harness, same environment)`
const ACROSS_MEAN = ' Did you mean "across"? It is the factor you vary: across: \'environment\'.'
const QUESTION_KEYS = Object.keys(questionObjectSchema.shape)

const describe = (value: unknown) => {
  if (Array.isArray(value)) return `a list of ${value.length}`
  if (typeof value === 'object' && value !== null) {
    const keys = Object.keys(value)
    return keys.length ? `an object with ${keys.map((k) => `"${k}"`).join(', ')}` : 'an object'
  }
  return JSON.stringify(value) ?? String(value)
}

/** One question's sentence: the union refuses it whole, so the branch it meant says why. */
function questionProblem(item: unknown, where: string): string {
  if (typeof item === 'string') {
    return `compare.questions in ${where} is an empty string. Ask something, e.g. ${QUESTION_EXAMPLE}.`
  }
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    return `compare.questions in ${where} takes strings or { question, model?, across? } (got ${describe(item)}), e.g. ${QUESTION_EXAMPLE}.`
  }
  const unknown = Object.keys(item).filter((k) => !QUESTION_KEYS.includes(k))
  if (unknown.length) {
    const hint = unknown.some((k) => k === 'cut' || k === 'cuts') ? ACROSS_MEAN : ''
    return `compare.questions in ${where} takes { question, model?, across? } (got ${unknown.map((k) => `"${k}"`).join(', ')}).${hint}`
  }
  const { question, model, across } = item as Record<string, unknown>
  const issues = questionObjectSchema.safeParse(item).error?.issues ?? []
  const at = (key: string) => issues.find((i) => i.path[0] === key)
  if (at('question')) {
    return `compare.questions in ${where} has an entry without its question (got ${describe(question)}), e.g. { question: 'Which is cleaner?', model: 'google/gemini-3.8-flash' }.`
  }
  if (at('across')) {
    return `compare.questions "${question}" in ${where}: across is ${ACROSS_HINT} (got ${describe(across)}). Leave it out to vary both.`
  }
  if ((at('model') as { params?: { evaluation?: boolean } } | undefined)?.params?.evaluation) {
    return `compare.questions "${question}" in ${where} names ${model}, an evaluation model: it scores yes/no questions and can't pick between two attempts. Use a language model, e.g. 'google/gemini-3.8-flash'.`
  }
  return `compare.questions "${question}" in ${where}: model is a 'provider/model' string, e.g. 'google/gemini-3.8-flash' (got ${describe(model)})`
}

function explain(where: string) {
  return (issue: Issue, value: unknown): string => {
    const spec = value as Record<string, unknown>
    if (issue.code === 'unrecognized_keys' && issue.path.length === 0) {
      const key = issue.keys[0] as string
      const hint =
        key === 'question'
          ? `. Did you mean "questions"? It's a list: ${QUESTION_EXAMPLE}.`
          : key === 'cut' || key === 'cuts'
            ? `.${ACROSS_MEAN}`
            : ''
      return `Unknown compare option "${key}" in ${where}${hint}`
    }
    const [key, index] = issue.path as [string, number?]
    const v = spec[key]
    switch (key) {
      case 'questions':
        if (issue.code === 'custom' && index === undefined) {
          return `compare.questions in ${where} asks "${twice((v as unknown[]).map(questionText))}" twice`
        }
        if (index !== undefined) return questionProblem((v as unknown[])[index], where)
        return Array.isArray(v)
          ? `compare.questions in ${where} is an empty list. Ask at least one, e.g. ${QUESTION_EXAMPLE}, or leave questions out.`
          : `compare.questions in ${where} is a list (got ${describe(v)}), e.g. ${QUESTION_EXAMPLE}.`
      case 'across': {
        const list = Array.isArray(v) ? v : [v]
        if (list.length === 0) {
          return `compare.across in ${where} is ${ACROSS_HINT}, or a list of those (got ${describe(v)}). Leave it out to vary both.`
        }
        const bad = list.findIndex((f) => !pairFactorSchema.safeParse(f).success)
        return bad === -1
          ? `compare.across in ${where} lists "${twice(list)}" twice`
          : `compare.across in ${where} is ${ACROSS_HINT}, or a list of those (got ${describe(list[bad])}).`
      }
      case 'baseline':
        return `compare.baseline in ${where} must be an environment from defineEnvironment (got ${describe(v)}). It is the control; variants are not layered on it or on the eval's environment. Leave it out to use the eval's environment as the control.`
      case 'gate':
        return `compare.gate must be one of ${compareGateSchema.options.join(', ')} in ${where}`
      case 'minLift':
        return `compare.minLift is points from -1 to 1 (got ${String(v)}) in ${where}`
      case 'harness': {
        const item = index === undefined ? undefined : (v as unknown[])[index]
        const kind = (item as { kind?: string } | null)?.kind
        const problem =
          kind && kind in FACTORY ? harnessProblem(item as HarnessDescriptor) : undefined
        return problem
          ? `compare.harness in ${where}: ${problem}`
          : `compare.harness must be a list of harness ids in ${where}`
      }
      default:
        return index === undefined
          ? `compare has no variants in ${where}. Give at least one environment.`
          : `compare takes environments (got ${describe((v as unknown[])[index])}) in ${where}. Variants share the eval's prompt and checks; if a variant needs different checks, write a separate eval.`
    }
  }
}

/** The order the hand-written checks ran in, so the first refusal stays the same. */
const ORDER = ['questions', 'across', 'baseline', 'gate', 'minLift', 'harness', 'variants']

/**
 * What's wrong with a compare object whose environments `environment` checks, or undefined.
 * `where` names the group or eval it's set on.
 */
export function compareProblem(value: unknown, where: string, environment: z.ZodType) {
  if (Array.isArray(value)) {
    return `compare must be an object in ${where}. Use compare: { baseline, variants: [...] }.`
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    !Array.isArray((value as { variants?: unknown }).variants)
  ) {
    return `compare takes { variants, baseline? } (got ${describe(value)}) in ${where}. Use compare: { variants: [a, b], baseline?, gate?, minLift?, harness?, questions?, across? }.`
  }
  return refusal(compareSchema(environment), value, explain(where), { order: ORDER })
}
