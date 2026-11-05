import type { CostTotal, CostUsd } from '../types.ts'

const micro = (usd: number) => Math.round(usd * 1e6) / 1e6

/** The parts' costs added up; undefined when none has one. `used` parts with no cost are `unpriced`. */
export function sumCosts(
  parts: { cost?: CostUsd | CostTotal; used: boolean }[],
): CostTotal | undefined {
  const costed = parts.flatMap((p) => (p.cost ? [p.cost] : []))
  if (!costed.length) return undefined
  const unpriced =
    parts.filter((p) => !p.cost && p.used).length +
    costed.reduce((n, c) => n + ('unpriced' in c ? (c.unpriced ?? 0) : 0), 0)
  const sources = new Set(costed.flatMap((c) => c.source.split(', ')))
  return {
    usd: micro(costed.reduce((sum, c) => sum + c.usd, 0)),
    basis: costed.every((c) => c.basis === 'reported') ? 'reported' : 'estimated',
    source: [...sources].join(', '),
    ...(unpriced ? { unpriced } : {}),
  }
}

/** A run's agent and judge costs as one; undefined when neither has one. */
export const runCost = (cost: { agentUsd?: CostTotal; judgeUsd?: CostTotal } | undefined) =>
  sumCosts([
    { cost: cost?.agentUsd, used: false },
    { cost: cost?.judgeUsd, used: false },
  ])

/** `$0.42`, `$0.0021`, `$12.40`, `<$0.0001`. */
export function formatUsd(usd: number): string {
  if (usd === 0) return '$0'
  if (usd < 0.0001) return '<$0.0001'
  return `$${usd >= 1 ? usd.toFixed(2) : Number(usd.toPrecision(2)).toString()}`
}

/** `$0.42`, `$0.42 (est.)`, `$0.42 (est., 1 unpriced)`; empty without a cost. */
export function formatCost(cost: CostUsd | CostTotal | undefined): string {
  if (!cost) return ''
  const notes = [
    ...(cost.basis === 'estimated' ? ['est.'] : []),
    ...('unpriced' in cost && cost.unpriced ? [`${cost.unpriced} unpriced`] : []),
  ]
  return `${formatUsd(cost.usd)}${notes.length ? ` (${notes.join(', ')})` : ''}`
}
