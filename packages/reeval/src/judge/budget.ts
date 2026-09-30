import type { JSONValue } from '../types.ts'

/**
 * Judge models whose input limit reeval knows, in tokens for the state plus the question. Jev
 * reads the state once and each question against it: 32k for the state and the longest question
 * (https://docs.typesafe.ai/models).
 */
const STATE_LIMITS: ReadonlyArray<[RegExp, number]> = [
  // `typesafe-ai/…` by name; `typesafe.evaluation/…` from a `createTypeSafeAi()` model object.
  [/^typesafe(?:-ai|\.evaluation)\/jev-/, 32_000],
]

/** The model's limit for the state and question, when reeval knows it. */
export const stateLimit = (model: string): number | undefined =>
  STATE_LIMITS.find(([pattern]) => pattern.test(model))?.[1]

/** Roughly four characters a token, as `reeval analyze` counts: an estimate, not the model's. */
const CHARS_PER_TOKEN = 4

const tokensOf = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN)

const k = (tokens: number) => (tokens < 1000 ? String(tokens) : `${Math.round(tokens / 1000)}k`)

/** Provider errors that say the input was too long for the model. */
const OVERFLOW =
  /max_tokens_exceeded|context.?length|context.?window|too many tokens|maximum context|token limit|prompt is too long|input is too long/i

export const isOverflowError = (message: string) => OVERFLOW.test(message)

type Part = { name: string; chars: number; items: Array<{ name: string; chars: number }> }

const diffItems = (patch: string) =>
  patch
    .split(/(?=^diff --git )/m)
    .map((part) => ({
      name: /^diff --git a\/.+ b\/(.+)$/m.exec(part)?.[1] ?? '',
      chars: part.length,
    }))
    .filter((item) => item.name)

/** The state's parts by size, each with its biggest files where it has any. */
function partsOf(state: Record<string, JSONValue>, question: string): Part[] {
  return [
    ...Object.entries(state).map(([name, value]): Part => {
      const text = typeof value === 'string' ? value : JSON.stringify(value)
      const items =
        name === 'diff' && typeof value === 'string'
          ? diffItems(value)
          : value && typeof value === 'object' && !Array.isArray(value)
            ? Object.entries(value).map(([file, content]) => ({
                name: file,
                chars:
                  typeof content === 'string' ? content.length : JSON.stringify(content).length,
              }))
            : []
      return { name, chars: text?.length ?? 0, items }
    }),
    { name: 'question', chars: question.length, items: [] },
  ].sort((a, b) => b.chars - a.chars)
}

/** The estimated size of what the judge reads, in tokens. */
export const inputTokens = (state: Record<string, JSONValue>, question: string) =>
  tokensOf(JSON.stringify(state).length + question.length)

/**
 * `diff 306k, of which dist/assets/index-….js is 296k; output 1k; …`: the state's parts by
 * estimated tokens, naming the biggest files in each.
 */
export function describeSize(state: Record<string, JSONValue>, question: string): string {
  const parts = partsOf(state, question)
  const big = parts.filter((p) => tokensOf(p.chars) >= 1000)
  return (big.length ? big : parts.slice(0, 1))
    .map((p) => {
      const top = p.items
        .sort((a, b) => b.chars - a.chars)
        .slice(0, 3)
        .filter((item) => tokensOf(item.chars) >= 1000)
        .map((item) => `${item.name} is ${k(tokensOf(item.chars))}`)
      return `${p.name} ${k(tokensOf(p.chars))}${top.length ? `, of which ${top.join(', ')}` : ''}`
    })
    .join('; ')
}

const HINT =
  "Narrow what the judge sees with include, e.g. c.judge(question, { include: ['src/'] }), or set judge: { include } in the config; files shows chosen files in full."

/** The message for a state over the model's known limit, before any call. */
export function overflowMessage(
  model: string,
  limit: number,
  state: Record<string, JSONValue>,
  question: string,
): string {
  return (
    `The judge's input is ~${k(inputTokens(state, question))} tokens (estimated), over ${model}'s ` +
    `limit of ${k(limit)} for the state and question: ${describeSize(state, question)}. ${HINT}`
  )
}

/** A provider's "too long" error, with what the input held. */
export const overflowDetail = (
  message: string,
  state: Record<string, JSONValue>,
  question: string,
) =>
  `${message}. The judge's input is ~${k(inputTokens(state, question))} tokens (estimated): ` +
  `${describeSize(state, question)}. ${HINT}`
