export { addUsage, promptTokens, sumUsage, tokenUsage, totalTokens } from '@reeval/agents/usage'

/** A token count as people read it: `9,512`, `430k`, `1,094k`. */
export const formatTokens = (n: number) =>
  n >= 10_000
    ? `${Math.round(n / 1000).toLocaleString('en-US')}k`
    : Math.round(n).toLocaleString('en-US')
