// The compare option's plain-data contract: its questions, the factors they vary, and the compare
// object itself. Environments in it are checked by whichever schema the caller passes (an
// `Environment` from `defineEnvironment`, or environment data from another language).
import { z } from 'zod'
import { isObjectLike } from '../object.ts'
import type {
  CompareGate,
  CompareOptions,
  CompareQuestion,
  Environment,
  HarnessDescriptor,
  PairFactor,
  QuestionOptions,
  QuestionStateOptions,
} from '../types.ts'
import { FACTORY, harnessDescriptorSchema, harnessProblem } from './harness.ts'
import { type Assert, closest, type Issue, nonEmpty, oneOf, refusal, type Same } from './shared.ts'

export const pairFactorSchema = z
  .enum(['environment', 'harness'])
  .describe('A matrix factor a compare question varies when pairing; the others are held.')

export const compareGateSchema = z.enum(['variants', 'all', 'none'])

/** Evaluation models score yes/no questions only, so they can't pick between two attempts. */
export const isEvaluationModel = (model: string) => model.startsWith('typesafe-ai/')

export const questionStateSchema = z
  .strictObject({
    task: z
      .boolean()
      .optional()
      .describe(
        'The prompts the attempt was sent, once for both sides when they match. Default true.',
      ),
    output: z
      .boolean()
      .optional()
      .describe("The final message: the agent's own account of its work. Default false."),
    files: z
      .boolean()
      .optional()
      .describe(
        "`status path` lines for the changed files, under `diff`'s patterns. Default false.",
      ),
    diff: z
      .union([z.boolean(), z.array(nonEmpty()).min(1)])
      .optional()
      .describe(
        'The diff since the eval started. A list is gitignore-style patterns over workspace paths: the last matching pattern wins and `!` excludes. Default true.',
      ),
    transcript: z
      .union([z.boolean(), z.enum(['tools', 'full'])])
      .optional()
      .describe(
        "The transcript as text lines: `true` is messages and tool calls with tool output clipped, `'tools'` tool calls only, `'full'` adds reasoning and whole tool output. It names each harness's tools, so a pair of two harnesses isn't blind. Default false.",
      ),
    turns: z
      .enum(['last', 'all'])
      .optional()
      .describe(
        "`'all'`: every turn under `turns`, each with its task, output and (with `transcript`) transcript; `'last'`: the last turn only. Default `'all'`.",
      ),
    checks: z
      .union([z.boolean(), z.array(nonEmpty())])
      .optional()
      .describe(
        '`c.exec` results; a list shows only those commands, as passed to `c.exec`. Default false.',
      ),
  })
  .describe(
    "What each side of a compare question shows: the keys of `judge.state` but `contents` (the attempts' workspaces are gone when questions are asked). An unset key keeps its default, which is what a question shows with no `state` at all: the task and the diff.",
  )

const questionArtifactsSchema = z.union([z.literal(true), z.array(nonEmpty()).min(1)])

const questionModelSchema = z
  .string()
  .refine((m) => m.includes('/'), { params: { provider: true } })
  .refine((m) => !isEvaluationModel(m), { params: { evaluation: true } })

export const questionOptionsSchema = z
  .strictObject({
    model: questionModelSchema
      .optional()
      .describe("`'provider/model'` that answers every question below it without its own `model`."),
    state: questionStateSchema.optional().describe('What each side shows.'),
    artifacts: questionArtifactsSchema
      .optional()
      .describe("Each side's own captures, by name; `true` sends all of them. Default none."),
  })
  .describe(
    'Defaults for every compare question: `model` and `artifacts` replaced, `state` merged key by key.',
  )

const questionObjectSchema = z.strictObject({
  question: nonEmpty(),
  model: questionModelSchema
    .optional()
    .describe("`'provider/model'` that answers it, over the cascaded `question.model`."),
  across: pairFactorSchema.optional().describe('The factor it varies when pairing.'),
  state: questionStateSchema
    .optional()
    .describe('What each side shows, over the cascaded `question.state`, key by key.'),
  artifacts: questionArtifactsSchema
    .optional()
    .describe(
      "Each side's own captures, by name; `true` sends all of them. Replaces `question.artifacts`.",
    ),
})

export const compareQuestionSchema = z
  .union([nonEmpty(), questionObjectSchema])
  .describe(
    "A question for pairwise judgement: its text, or the text and the `'provider/model'` that answers it. Without a model, the cascaded `question.model` answers, else `analysis.model`, else the judge's when it's a language model. `across` is the factor it varies when pairing; without it (and without a one-factor `compare.across`) both pair kinds run. `state` and `artifacts` choose what each side shows.",
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
  Assert<Same<z.infer<typeof questionStateSchema>, QuestionStateOptions>>,
  Assert<Same<keyof z.infer<typeof questionStateSchema>, keyof QuestionStateOptions>>,
  Assert<Same<z.infer<typeof questionOptionsSchema>, QuestionOptions>>,
  Assert<Same<z.infer<typeof authoredCompare>, CompareOptions<Environment>>>,
  Assert<Same<keyof z.infer<typeof authoredCompare>, keyof CompareOptions<Environment>>>,
]

const QUESTION_EXAMPLE = `questions: ['Which handles state more cleanly?']`
const ACROSS_HINT = `'environment' (vary the environment, same harness) or 'harness' (vary the harness, same environment)`
const ACROSS_MEAN = ' Did you mean "across"? It is the factor you vary: across: \'environment\'.'
const QUESTION_KEYS = Object.keys(questionObjectSchema.shape)
const QUESTION_SHAPE = '{ question, model?, across?, state?, artifacts? }'
const STATE_KEYS = Object.keys(questionStateSchema.shape) as Array<keyof QuestionStateOptions>

const STATE_VALUES: Record<keyof QuestionStateOptions, string> = {
  task: 'true or false',
  output: 'true or false',
  files: 'true or false',
  diff: 'true, false or a non-empty list of patterns',
  transcript: "true, false, 'tools' or 'full'",
  turns: "'last' or 'all'",
  checks: 'true, false or a list of commands',
}

const describe = (value: unknown) => {
  if (Array.isArray(value)) return `a list of ${value.length}`
  if (typeof value === 'object' && value !== null) {
    const keys = Object.keys(value)
    return keys.length ? `an object with ${keys.map((k) => `"${k}"`).join(', ')}` : 'an object'
  }
  return JSON.stringify(value) ?? String(value)
}

/**
 * What's wrong with a question's `state` or `artifacts`, as one sentence, or undefined. `name`
 * turns a key into how the sentence names it: `question.state` on the option,
 * `compare.questions "…" state` on an entry.
 */
function questionPartsProblem(
  value: Record<string, unknown>,
  name: (key: string) => string,
  where: string,
): string | undefined {
  const { state, artifacts } = value
  if (state !== undefined) {
    if (!isObjectLike(state) || Array.isArray(state)) {
      return `${name('state')} in ${where} must be an object such as { transcript: 'tools' } (got ${describe(state)})`
    }
    for (const [key, v] of Object.entries(state)) {
      if (key === 'contents') {
        return `${name('state.contents')} in ${where} can't be set: questions are asked after the attempts, when their workspaces are gone. Narrow state.diff instead.`
      }
      const schema = questionStateSchema.shape[key as keyof QuestionStateOptions]
      if (!schema) {
        const hint = closest(key, STATE_KEYS)
        return `Unknown ${name('state')} key "${key}" in ${where}.${hint ? ` Did you mean "${hint}"?` : ''}`
      }
      if (!schema.safeParse(v).success) {
        return `${name(`state.${key}`)} in ${where} must be ${STATE_VALUES[key as keyof QuestionStateOptions]} (got ${describe(v)})`
      }
    }
  }
  if (artifacts !== undefined && !questionArtifactsSchema.safeParse(artifacts).success) {
    return `${name('artifacts')} in ${where} must be true or a non-empty list of capture names (got ${describe(artifacts)})`
  }
  return undefined
}

/** What's wrong with the `question` option set in `where`, as one sentence, or undefined. */
export function questionOptionsProblem(value: unknown, where: string): string | undefined {
  if (!isObjectLike(value) || Array.isArray(value)) {
    return `question in ${where} is { model?, state?, artifacts? } (got ${describe(value)}), e.g. question: { model: 'google/gemini-3.8-flash' }`
  }
  const keys = Object.keys(questionOptionsSchema.shape)
  for (const key of Object.keys(value)) {
    if (keys.includes(key)) continue
    if (key === 'across') {
      return `Unknown question option "across" in ${where}. across goes on each compare.questions entry, { question, across }, or on compare.across.`
    }
    const hint = closest(key, keys)
    return `Unknown question option "${key}" in ${where}.${hint ? ` Did you mean "${hint}"?` : ''} question takes model, state and artifacts.`
  }
  const { model } = value as { model?: unknown }
  if (model !== undefined && typeof model === 'string' && isEvaluationModel(model)) {
    return `question.model in ${where} names ${model}, an evaluation model: it scores yes/no questions and can't pick between two attempts. Use a language model, e.g. 'google/gemini-3.8-flash'.`
  }
  if (model !== undefined && !questionModelSchema.safeParse(model).success) {
    return `question.model in ${where} is a 'provider/model' string, e.g. 'google/gemini-3.8-flash' (got ${describe(model)})`
  }
  return questionPartsProblem(value, (key) => `question.${key}`, where)
}

/** One question's sentence: the union refuses it whole, so the branch it meant says why. */
function questionProblem(item: unknown, where: string): string {
  if (typeof item === 'string') {
    return `compare.questions in ${where} is an empty string. Ask something, e.g. ${QUESTION_EXAMPLE}.`
  }
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    return `compare.questions in ${where} takes strings or ${QUESTION_SHAPE} (got ${describe(item)}), e.g. ${QUESTION_EXAMPLE}.`
  }
  const unknown = Object.keys(item).filter((k) => !QUESTION_KEYS.includes(k))
  if (unknown.length) {
    const hint = unknown.some((k) => k === 'cut' || k === 'cuts') ? ACROSS_MEAN : ''
    return `compare.questions in ${where} takes ${QUESTION_SHAPE} (got ${unknown.map((k) => `"${k}"`).join(', ')}).${hint}`
  }
  const { question, model, across } = item as Record<string, unknown>
  const issues = questionObjectSchema.safeParse(item).error?.issues ?? []
  const at = (key: string) => issues.find((i) => i.path[0] === key)
  if (at('question')) {
    return `compare.questions in ${where} has an entry without its question${question === undefined ? '' : ` (got ${describe(question)})`}, e.g. { question: 'Which is cleaner?', model: 'google/gemini-3.8-flash' }.`
  }
  if (at('across')) {
    return `compare.questions "${question}" in ${where}: across is ${ACROSS_HINT} (got ${describe(across)}). Leave it out to vary both.`
  }
  const parts = questionPartsProblem(
    item as Record<string, unknown>,
    (key) => `compare.questions "${question}" ${key}`,
    where,
  )
  if (parts) return parts
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
            : `. compare takes ${Object.keys(compareSchema(z.any()).shape).join(', ')}.`
      return `Unknown compare option "${key}" in ${where}${hint}`
    }
    const [key, index] = issue.path as [string, number?]
    const v = spec[key]
    switch (key) {
      case 'questions':
        if (issue.code === 'custom' && index === undefined) {
          return `compare.questions in ${where} asks "${twice((v as unknown[]).map(questionText))}" twice. Ask each question once.`
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
          ? `compare.across in ${where} lists "${twice(list)}" twice. List each factor once.`
          : `compare.across in ${where} is ${ACROSS_HINT}, or a list of those (got ${describe(list[bad])}).`
      }
      case 'baseline':
        return `compare.baseline in ${where} must be an environment from defineEnvironment (got ${describe(v)}). It is the control; variants are not layered on it or on the eval's environment. Leave it out to use the eval's environment as the control.`
      case 'gate':
        return `compare.gate in ${where} is ${oneOf(compareGateSchema.options)} (got ${describe(v)})`
      case 'minLift':
        return `compare.minLift in ${where} is points from -1 to 1, e.g. minLift: 0.1 (got ${describe(v)})`
      case 'harness': {
        const item = index === undefined ? undefined : (v as unknown[])[index]
        const kind = (item as { kind?: string } | null)?.kind
        const problem =
          kind && kind in FACTORY ? harnessProblem(item as HarnessDescriptor) : undefined
        return problem
          ? `compare.harness in ${where}: ${problem}`
          : `compare.harness in ${where} must be a list of harness ids, e.g. harness: ['cursor:composer-2.5'] (got ${describe(index === undefined ? v : item)})`
      }
      default:
        return index === undefined
          ? `compare has no variants in ${where}. Give at least one environment.`
          : `compare.variants in ${where} must be environments from defineEnvironment (got ${describe((v as unknown[])[index])}). Variants share the eval's prompt and checks; if a variant needs different checks, write a separate eval.`
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
    return `compare in ${where} must be an object, not a list. Use compare: { baseline, variants: [...] }.`
  }
  if (!isObjectLike(value) || !Array.isArray(value.variants)) {
    return `compare in ${where} takes { variants, baseline? } (got ${describe(value)}). Use compare: { variants: [a, b], baseline?, gate?, minLift?, harness?, questions?, across? }.`
  }
  return refusal(compareSchema(environment), value, explain(where), { order: ORDER })
}
