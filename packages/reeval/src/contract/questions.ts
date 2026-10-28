// The questions option's plain-data contract: each question, the factors a pairwise one varies,
// what it's shown of each attempt, and the cascading `question` defaults.
import { z } from 'zod'
import { isObjectLike } from '../object.ts'
import type { PairFactor, QuestionFields, QuestionInputs, QuestionOptions } from '../types.ts'
import { inputsOn, orList, sharedInputFields, turnsSchema } from './judge.ts'
import { type Assert, closest, nonEmpty, type Same } from './shared.ts'

export const pairFactorSchema = z.enum(['environment', 'harness'])

/** Evaluation models score yes/no questions only, so they can't answer a question. */
export const isEvaluationModel = (model: string) => model.startsWith('typesafe-ai/')

const questionArtifactsSchema = z.union([z.literal(true), z.array(nonEmpty()).min(1)])

const questionInputFields = {
  ...sharedInputFields,
  artifacts: questionArtifactsSchema.optional(),
}

export const questionInputsSchema = z.strictObject(questionInputFields)

const questionModelSchema = z
  .string()
  .refine((m) => m.includes('/'), { params: { provider: true } })
  .refine((m) => !isEvaluationModel(m), { params: { evaluation: true } })

export const questionOptionsSchema = z.strictObject({
  model: questionModelSchema.optional(),
})

export const QUESTION_INPUT_KEYS = Object.keys(questionInputFields) as Array<keyof QuestionInputs>

/** The first item a list holds twice. */
const twice = (items: unknown[]) => items.find((k, i) => items.indexOf(k) !== i)

const unique = (list: unknown[], ctx: z.RefinementCtx) => {
  if (twice(list) !== undefined) ctx.addIssue({ code: 'custom', message: 'twice' })
}

const acrossSchema = z.union([
  pairFactorSchema,
  z.array(pairFactorSchema).min(1).superRefine(unique),
])

const choicesSchema = z.array(nonEmpty()).min(2).superRefine(unique)

export const questionSchema = z
  .strictObject({
    question: nonEmpty(),
    model: questionModelSchema.optional(),
    across: acrossSchema.optional(),
    choices: choicesSchema.optional(),
    turns: turnsSchema.optional(),
    ...questionInputFields,
  })
  .superRefine((q, ctx) => {
    if (q.across !== undefined && q.choices !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['choices'], message: 'with across' })
    }
    if (!inputsOn(q, QUESTION_INPUT_KEYS).length) {
      ctx.addIssue({ code: 'custom', message: 'no input' })
    }
  })

const questionText = (q: unknown) => (q as { question: string }).question

export const questionsSchema = z.array(questionSchema).superRefine((list, ctx) => {
  if (twice(list.map(questionText)) !== undefined) {
    ctx.addIssue({ code: 'custom', message: 'twice' })
  }
})

export type _SameAsSchema = [
  Assert<Same<z.infer<typeof pairFactorSchema>, PairFactor>>,
  Assert<Same<z.infer<typeof questionSchema>, QuestionFields>>,
  Assert<Same<keyof z.infer<typeof questionSchema>, keyof QuestionFields>>,
  Assert<Same<z.infer<typeof questionInputsSchema>, QuestionInputs>>,
  Assert<Same<z.infer<typeof questionOptionsSchema>, QuestionOptions>>,
]

const QUESTION_EXAMPLE = `questions: [{ question: 'How did the agent find the failing test?', transcript: true }]`
const ACROSS_HINT = `'environment' (vary the environment, same harness) or 'harness' (vary the harness, same environment)`
const ACROSS_MEAN =
  ' Did you mean "across"? It is the factor a pairwise question varies: across: \'environment\'.'
const QUESTION_KEYS = Object.keys(questionSchema.shape)
const INPUTS = orList(QUESTION_INPUT_KEYS)
const QUESTION_SHAPE = `{ question, model?, across?, choices?, turns? } with at least one of ${INPUTS}`

const VALUES: Record<Exclude<keyof QuestionInputs, 'artifacts'> | 'turns', string> = {
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

/** What's wrong with an entry's inputs and `turns`, as one sentence, or undefined. */
function questionInputsProblem(
  value: Record<string, unknown>,
  at: string,
  where: string,
): string | undefined {
  for (const [key, v] of Object.entries(value)) {
    if (key === 'artifacts') {
      if (!questionArtifactsSchema.safeParse(v).success) {
        return `${at} artifacts in ${where} must be true or a non-empty list of capture names (got ${describe(v)})`
      }
      continue
    }
    if (!(key in VALUES)) continue
    const schema =
      key === 'turns' ? turnsSchema : sharedInputFields[key as keyof typeof sharedInputFields]
    if (!schema.safeParse(v).success) {
      return `${at} ${key} in ${where} must be ${VALUES[key as keyof typeof VALUES]} (got ${describe(v)})`
    }
  }
  if (!inputsOn(value, QUESTION_INPUT_KEYS).length) {
    return `${at} in ${where} shows the model nothing: turn on at least one of ${INPUTS}, e.g. { question: '…', diff: true }.`
  }
  return undefined
}

/** What's wrong with the `question` option set in `where`, as one sentence, or undefined. */
export function questionOptionsProblem(value: unknown, where: string): string | undefined {
  if (!isObjectLike(value) || Array.isArray(value)) {
    return `question in ${where} is { model? } (got ${describe(value)}), e.g. question: { model: 'google/gemini-3.8-flash' }`
  }
  const keys = Object.keys(questionOptionsSchema.shape)
  for (const key of Object.keys(value)) {
    if (keys.includes(key)) continue
    if (key === 'across' || key === 'choices' || key === 'turns' || key in questionInputFields) {
      return `Unknown question option "${key}" in ${where}. ${key} goes on each questions entry, { question, ${key} }: what a question is and what it's shown are its own.`
    }
    const hint = closest(key, keys)
    return `Unknown question option "${key}" in ${where}.${hint ? ` Did you mean "${hint}"?` : ''} question takes model.`
  }
  const { model } = value as { model?: unknown }
  if (model !== undefined && typeof model === 'string' && isEvaluationModel(model)) {
    return `question.model in ${where} names ${model}, an evaluation model: it scores yes/no questions and can't answer a question. Use a language model, e.g. 'google/gemini-3.8-flash'.`
  }
  if (model !== undefined && !questionModelSchema.safeParse(model).success) {
    return `question.model in ${where} is a 'provider/model' string, e.g. 'google/gemini-3.8-flash' (got ${describe(model)})`
  }
  return undefined
}

/** What's wrong with an entry's `across`, or undefined. */
function acrossProblem(question: string, across: unknown, where: string): string | undefined {
  if (acrossSchema.safeParse(across).success) return undefined
  const at = `questions "${question}" in ${where}`
  if (
    Array.isArray(across) &&
    across.length > 0 &&
    across.every((f) => pairFactorSchema.safeParse(f).success)
  ) {
    return `${at}: across lists "${twice(across)}" twice. List each factor once.`
  }
  const bad = Array.isArray(across)
    ? across.find((f) => !pairFactorSchema.safeParse(f).success)
    : across
  return `${at}: across is ${ACROSS_HINT}, or a list of both (got ${describe(Array.isArray(across) && across.length === 0 ? across : bad)}). Leave it out to ask each attempt on its own.`
}

/** What's wrong with an entry's `choices`, or undefined. */
function choicesProblem(question: string, choices: unknown, where: string): string | undefined {
  if (choicesSchema.safeParse(choices).success) return undefined
  const at = `questions "${question}" choices in ${where}`
  if (
    Array.isArray(choices) &&
    choices.length >= 2 &&
    choices.every((c) => nonEmpty().safeParse(c).success)
  ) {
    return `${at} lists "${twice(choices)}" twice. List each answer once.`
  }
  const blank = Array.isArray(choices) && choices.find((c) => !nonEmpty().safeParse(c).success)
  if (blank !== undefined && blank !== false) {
    return `${at} has an answer that isn't a non-empty string (got ${describe(blank)}), e.g. choices: ['the test', 'the code']`
  }
  return `${at} is a list of at least two answers, e.g. choices: ['the test', 'the code'] (got ${describe(choices)})`
}

/** One question's sentence. */
function questionProblem(item: unknown, where: string): string {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    return `questions in ${where} takes ${QUESTION_SHAPE} (got ${describe(item)}), e.g. ${QUESTION_EXAMPLE}.`
  }
  const unknown = Object.keys(item).filter((k) => !QUESTION_KEYS.includes(k))
  if (unknown.includes('contents')) {
    return `questions in ${where} can't set contents: questions are asked after the attempts, when their workspaces are gone. Narrow diff instead.`
  }
  if (unknown.length) {
    const hint = unknown.some((k) => k === 'cut' || k === 'cuts') ? ACROSS_MEAN : ''
    return `questions in ${where} takes ${QUESTION_SHAPE} (got ${unknown.map((k) => `"${k}"`).join(', ')}).${hint}`
  }
  const { question, model, across, choices } = item as Record<string, unknown>
  if (!nonEmpty().safeParse(question).success) {
    return `questions in ${where} has an entry without its question${question === undefined ? '' : ` (got ${describe(question)})`}, e.g. { question: 'Which is cleaner?', across: 'environment' }.`
  }
  const text = question as string
  if (across !== undefined) {
    const problem = acrossProblem(text, across, where)
    if (problem) return problem
  }
  if (choices !== undefined) {
    const problem = choicesProblem(text, choices, where)
    if (problem) return problem
  }
  if (across !== undefined && choices !== undefined) {
    return `questions "${text}" in ${where} sets both across and choices. choices are the answers a question asked of each attempt picks from, and across makes it pick between two attempts instead: drop choices to vote between pairs, or drop across to ask each attempt.`
  }
  const parts = questionInputsProblem(item as Record<string, unknown>, `questions "${text}"`, where)
  if (parts) return parts
  if (typeof model === 'string' && isEvaluationModel(model)) {
    return `questions "${text}" in ${where} names ${model}, an evaluation model: it scores yes/no questions and can't answer a question. Use a language model, e.g. 'google/gemini-3.8-flash'.`
  }
  return `questions "${text}" in ${where}: model is a 'provider/model' string, e.g. 'google/gemini-3.8-flash' (got ${describe(model)})`
}

/** What's wrong with the `questions` option set in `where`, as one sentence, or undefined. */
export function questionsProblem(value: unknown, where: string): string | undefined {
  if (questionsSchema.safeParse(value).success) return undefined
  if (!Array.isArray(value)) {
    return `questions in ${where} is a list (got ${describe(value)}), e.g. ${QUESTION_EXAMPLE}.`
  }
  const bad = value.find((q) => !questionSchema.safeParse(q).success)
  if (bad !== undefined) return questionProblem(bad, where)
  return `questions in ${where} asks "${twice(value.map(questionText))}" twice. Ask each question once.`
}
