// Uncertainty for pass rates and lift. Attempts are few (2–10 is typical), so intervals are wide;
// the point is to say so, not to hide it behind a single number.

/** Two-sided 95%. */
const Z = 1.959964

export type Interval = { low: number; high: number }

/**
 * The Wilson score interval for `pass` successes out of `n`. Unlike the normal approximation it
 * stays inside [0, 1] and is sensible at 0/n and n/n. With no attempts it's [0, 1].
 */
export function wilson(pass: number, n: number): Interval {
  if (n === 0) return { low: 0, high: 1 }
  const p = pass / n
  const z2 = Z * Z
  const denominator = 1 + z2 / n
  const center = (p + z2 / (2 * n)) / denominator
  const half = (Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) }
}

/**
 * The difference of two pass rates (variant minus control), with Newcombe's hybrid score
 * interval: each rate's Wilson interval combined, so it inherits Wilson's behaviour at 0 and 1.
 */
export function liftInterval(
  variant: { pass: number; n: number },
  control: { pass: number; n: number },
): Interval & { points: number } {
  const p1 = variant.n ? variant.pass / variant.n : 0
  const p2 = control.n ? control.pass / control.n : 0
  const a = wilson(variant.pass, variant.n)
  const b = wilson(control.pass, control.n)
  const points = p1 - p2
  return {
    points,
    low: points - Math.sqrt((p1 - a.low) ** 2 + (b.high - p2) ** 2),
    high: points + Math.sqrt((a.high - p1) ** 2 + (p2 - b.low) ** 2),
  }
}

/** Rounded to three places, as the record stores rates and points. */
export const round3 = (x: number) => Math.round(x * 1000) / 1000

/** Linear-interpolated quantile (`q` from 0 to 1) of unsorted numbers; null for none. */
export function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const at = (sorted.length - 1) * q
  const lo = Math.floor(at)
  const hi = Math.ceil(at)
  const a = sorted[lo] as number
  const b = sorted[hi] as number
  return a + (b - a) * (at - lo)
}

export const median = (values: readonly number[]) => quantile(values, 0.5)

/** Above this many ways to split the pooled values, the normal approximation stands in. */
const EXACT_LIMIT = 200_000

const choose = (n: number, k: number) => {
  let r = 1
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i
  return Math.round(r)
}

/**
 * Two-sided Mann–Whitney (Wilcoxon rank-sum) p-value for `xs` against `ys`: exact, by every split
 * of the pooled values, with mid-ranks for ties; the normal approximation with a tie correction
 * above `EXACT_LIMIT` splits. Null when either side is empty.
 */
export function mannWhitney(xs: readonly number[], ys: readonly number[]): number | null {
  const n1 = xs.length
  const n2 = ys.length
  if (n1 === 0 || n2 === 0) return null
  const pooled = [...xs, ...ys].map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v)
  const ranks = new Array<number>(pooled.length)
  for (let i = 0; i < pooled.length; ) {
    let j = i
    while (j + 1 < pooled.length && pooled[j + 1]?.v === pooled[i]?.v) j++
    for (let k = i; k <= j; k++) ranks[pooled[k]?.i as number] = (i + j) / 2 + 1
    i = j + 1
  }
  const n = n1 + n2
  const expected = (n1 * (n + 1)) / 2
  const observed = Math.abs(ranks.slice(0, n1).reduce((a, b) => a + b, 0) - expected)
  if (choose(n, n1) > EXACT_LIMIT) {
    const counts = new Map<number, number>()
    for (const { v } of pooled) counts.set(v, (counts.get(v) ?? 0) + 1)
    const ties = [...counts.values()].reduce((a, t) => a + t ** 3 - t, 0)
    const variance = ((n1 * n2) / 12) * (n + 1 - ties / (n * (n - 1)))
    if (variance <= 0) return 1
    const z = Math.max(0, observed - 0.5) / Math.sqrt(variance)
    return Math.min(1, 2 * (1 - normalCdf(z)))
  }
  let extreme = 0
  let total = 0
  const pick = (start: number, left: number, sum: number) => {
    if (left === 0) {
      total++
      if (Math.abs(sum - expected) >= observed - 1e-9) extreme++
      return
    }
    for (let i = start; i <= n - left; i++) pick(i + 1, left - 1, sum + (ranks[i] as number))
  }
  pick(0, n1, 0)
  return extreme / total
}

/** The smallest two-sided p an exact rank test can reach with these group sizes. */
export const minimumP = (n1: number, n2: number) =>
  n1 === 0 || n2 === 0 ? 1 : Math.min(1, 2 / choose(n1 + n2, n1))

function normalCdf(z: number): number {
  // Abramowitz and Stegun 7.1.26: plenty for a p-value that's only compared with 0.05.
  const t = 1 / (1 + (0.3275911 * Math.abs(z)) / Math.SQRT2)
  const poly =
    t *
    (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))))
  const erf = 1 - poly * Math.exp(-(z * z) / 2)
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2
}
