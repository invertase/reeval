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
