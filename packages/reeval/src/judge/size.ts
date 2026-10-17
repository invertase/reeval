import type { JSONValue } from '../types.ts'

/** Roughly four characters a token, as `reeval analyze` counts: an estimate, not the model's. */
const CHARS_PER_TOKEN = 4

const tokensOf = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN)

const k = (tokens: number) => (tokens < 1000 ? String(tokens) : `${Math.round(tokens / 1000)}k`)

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
const inputTokens = (state: Record<string, JSONValue>, question: string) =>
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

/** `Narrow sees.diff, sees.transcript or sees.output.`: the state's parts, largest first. */
function seesHint(state: Record<string, JSONValue>, question: string): string {
  const keys = partsOf(state, question)
    .filter((p) => p.name !== 'question')
    .map((p) => `sees.${p.name}`)
  if (!keys.length) return ''
  const last = keys.pop()
  return ` Narrow ${keys.length ? `${keys.join(', ')} or ${last}` : last}.`
}

/**
 * A provider's error, as the provider worded it, then what the judge's input held: its estimated
 * size and biggest parts and files, and the `sees` keys that were on, largest first. reeval knows
 * no model's limit, so this follows every provider error.
 */
export const withInputSize = (
  message: string,
  state: Record<string, JSONValue>,
  question: string,
) =>
  `${message}\nThe judge's input was ~${k(inputTokens(state, question))} tokens (estimated): ` +
  `${describeSize(state, question)}.${seesHint(state, question)}`
