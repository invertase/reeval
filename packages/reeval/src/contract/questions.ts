// The questions option's plain-data contract: each question, the factors a pairwise one varies,
// what it's shown of each attempt, and the cascading `question` defaults.
import { z } from 'zod'
import { isObjectLike } from '../object.ts'
import type { PairFactor, Question, QuestionOptions, QuestionStateOptions } from '../types.ts'
import { type Assert, closest, nonEmpty, type Same } from './shared.ts'

export const pairFactorSchema = z
  .enum(['environment', 'harness'])
  .describe('A matrix factor a pairwise question varies; the others are held.')

/** Evaluation models score yes/no questions only, so they can't answer a question. */
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
      .describe(
        "The final message: the agent's own account of its work. Default false in a pair, true per attempt.",
      ),
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
        "The transcript as text lines: `true` is messages and tool calls with tool output clipped, `'tools'` tool calls only, `'full'` adds reasoning and whole tool output. It names each harness's tools, so a pair of two harnesses isn't blind. Default false in a pair, true per attempt.",
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
    "What a question is shown of each attempt: the keys of `judge.state` but `contents` (the attempts' workspaces are gone when questions are asked). An unset key keeps its default: a pairwise question shows the task and the diff; one asked of each attempt also shows the final message and the transcript.",
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
    state: questionStateSchema.optional().describe("What it's shown of each attempt."),
    artifacts: questionArtifactsSchema
      .optional()
      .describe("Each attempt's own captures, by name; `true` sends all of them. Default none."),
  })
  .describe(
    'Defaults for every question: `model` and `artifacts` replaced, `state` merged key by key.',
  )

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

const questionObjectSchema = z
  .strictObject({
    question: nonEmpty(),
    model: questionModelSchema
      .optional()
      .describe("`'provider/model'` that answers it, over the cascaded `question.model`."),
    across: acrossSchema
      .optional()
      .describe(
        "The factor it varies when pairing, or both: `'environment'` holds the harness, `'harness'` holds the environment. Unset, it's asked of each attempt on its own.",
      ),
    choices: choicesSchema
      .optional()
      .describe('The answers a question asked of each attempt picks from, with a short reason.'),
    state: questionStateSchema
      .optional()
      .describe("What it's shown of each attempt, over the cascaded `question.state`, key by key."),
    artifacts: questionArtifactsSchema
      .optional()
      .describe(
        "Each attempt's own captures, by name; `true` sends all of them. Replaces `question.artifacts`.",
      ),
  })
  .superRefine((q, ctx) => {
    if (q.across !== undefined && q.choices !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['choices'], message: 'with across' })
    }
  })

export const questionSchema = z
  .union([nonEmpty(), questionObjectSchema])
  .describe(
    "A question a language model answers after the attempts: its text, or the text and its options. With `across`, it picks between two attempts that differ only in that factor, in both orders; without it, it's asked of each attempt on its own. Without a model, the cascaded `question.model` answers, else `analysis.model`, else the judge's when it's a language model. `state` and `artifacts` choose what it's shown of each attempt.",
  )

const questionText = (q: unknown) =>
  typeof q === 'string' ? q : (q as { question: string }).question

export const questionsSchema = z.array(questionSchema).superRefine((list, ctx) => {
  if (twice(list.map(questionText)) !== undefined) {
    ctx.addIssue({ code: 'custom', message: 'twice' })
  }
})

export type _SameAsSchema = [
  Assert<Same<z.infer<typeof pairFactorSchema>, PairFactor>>,
  Assert<Same<z.infer<typeof questionSchema>, Question>>,
  Assert<Same<z.infer<typeof questionStateSchema>, QuestionStateOptions>>,
  Assert<Same<keyof z.infer<typeof questionStateSchema>, keyof QuestionStateOptions>>,
  Assert<Same<z.infer<typeof questionOptionsSchema>, QuestionOptions>>,
]

const QUESTION_EXAMPLE = `questions: ['How did the agent find the failing test?']`
const ACROSS_HINT = `'environment' (vary the environment, same harness) or 'harness' (vary the harness, same environment)`
const ACROSS_MEAN =
  ' Did you mean "across"? It is the factor a pairwise question varies: across: \'environment\'.'
const QUESTION_KEYS = Object.keys(questionObjectSchema.shape)
const QUESTION_SHAPE = '{ question, model?, across?, choices?, state?, artifacts? }'
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
 * `questions "…" state` on an entry.
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
    if (key === 'across' || key === 'choices') {
      return `Unknown question option "${key}" in ${where}. ${key} goes on each questions entry, { question, ${key} }: it says what kind of question that entry is.`
    }
    const hint = closest(key, keys)
    return `Unknown question option "${key}" in ${where}.${hint ? ` Did you mean "${hint}"?` : ''} question takes model, state and artifacts.`
  }
  const { model } = value as { model?: unknown }
  if (model !== undefined && typeof model === 'string' && isEvaluationModel(model)) {
    return `question.model in ${where} names ${model}, an evaluation model: it scores yes/no questions and can't answer a question. Use a language model, e.g. 'google/gemini-3.8-flash'.`
  }
  if (model !== undefined && !questionModelSchema.safeParse(model).success) {
    return `question.model in ${where} is a 'provider/model' string, e.g. 'google/gemini-3.8-flash' (got ${describe(model)})`
  }
  return questionPartsProblem(value, (key) => `question.${key}`, where)
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

/** One question's sentence: the union refuses it whole, so the branch it meant says why. */
function questionProblem(item: unknown, where: string): string {
  if (typeof item === 'string') {
    return `questions in ${where} has an empty string. Ask something, e.g. ${QUESTION_EXAMPLE}.`
  }
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    return `questions in ${where} takes strings or ${QUESTION_SHAPE} (got ${describe(item)}), e.g. ${QUESTION_EXAMPLE}.`
  }
  const unknown = Object.keys(item).filter((k) => !QUESTION_KEYS.includes(k))
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
  const parts = questionPartsProblem(
    item as Record<string, unknown>,
    (key) => `questions "${text}" ${key}`,
    where,
  )
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
