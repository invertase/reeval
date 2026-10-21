// `analysis.maxTokens` as a gate on each eval's insight calls. Before an eval starts it reserves
// an estimate of what it will use: the mean of the evals that finished having used tokens, or
// `FIRST_ESTIMATE` before any has. It starts only when the tokens used, the reservations in flight and its estimate fit
// the budget; when they don't but an eval is in flight, it waits for that eval to settle its
// reservation; when nothing is in flight it never will fit, so it's skipped. A run can go over
// `maxTokens` only by what the evals in flight use beyond their estimates. A budget below
// `FIRST_ESTIMATE` starts no eval. Pure: the decisions depend on the ledger alone.

/** What an eval is estimated to use before any eval has finished, from gemini-3.8-flash runs. */
export const FIRST_ESTIMATE = 6_000

export type Ledger = {
  maxTokens: number
  /** Tokens the finished evals used. */
  used: number
  /** The estimates the evals in flight hold. */
  reserved: number
  /** The finished evals that used tokens, which the mean is over. */
  finished: number
}

export const ledger = (maxTokens: number): Ledger => ({
  maxTokens,
  used: 0,
  reserved: 0,
  finished: 0,
})

/** What the next eval reserves: the finished evals' mean, else `FIRST_ESTIMATE`. */
export const estimate = (l: Ledger): number =>
  l.finished ? Math.ceil(l.used / l.finished) : FIRST_ESTIMATE

/** Whether the next eval in priority order starts now, waits for one in flight, or is skipped. */
export function admit(l: Ledger): 'start' | 'wait' | 'skip' {
  if (l.used + l.reserved + estimate(l) <= l.maxTokens) return 'start'
  return l.reserved > 0 ? 'wait' : 'skip'
}

/** Reserves the next eval's estimate; returns it, to hand back to `settle`. */
export function reserve(l: Ledger): number {
  const tokens = estimate(l)
  l.reserved += tokens
  return tokens
}

/**
 * Swaps an eval's reservation for what it used. One that used nothing (its calls failed or timed
 * out before any usage came back) says nothing of what the next will use, so it leaves the mean.
 */
export function settle(l: Ledger, reserved: number, used: number): void {
  l.reserved -= reserved
  l.used += used
  if (used > 0) l.finished++
}
