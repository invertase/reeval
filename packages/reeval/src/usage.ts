import type { TokenUsage } from './types.ts'

/** Two counts as one; null only when neither reported any. */
export function addUsage(a: TokenUsage | null, b: TokenUsage | null): TokenUsage | null {
  if (!a || !b) return a ?? b
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning:
      a.reasoning === null && b.reasoning === null ? null : (a.reasoning ?? 0) + (b.reasoning ?? 0),
  }
}

/** The total of every count that was reported; null when none was. */
export const sumUsage = (usages: Iterable<TokenUsage | null | undefined>): TokenUsage | null => {
  let total: TokenUsage | null = null
  for (const u of usages) total = addUsage(total, u ?? null)
  return total
}

/** Every token the prompt side used: uncached input plus cache reads and writes. */
export const promptTokens = (u: TokenUsage) => u.input + u.cacheRead + u.cacheWrite

/** Prompt side, output, and reasoning when the harness reported it. No USD. */
export const totalTokens = (u: TokenUsage) => promptTokens(u) + u.output + (u.reasoning ?? 0)

/** A token count as people read it: `9,512`, `430k`, `1,094k`. */
export const formatTokens = (n: number) =>
  n >= 10_000
    ? `${Math.round(n / 1000).toLocaleString('en-US')}k`
    : Math.round(n).toLocaleString('en-US')
