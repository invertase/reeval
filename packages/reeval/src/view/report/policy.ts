/**
 * Report layout and delta defaults. Flip one field to change every surface that
 * renders a `RunReport`; the shape of `RunReport` itself does not change.
 */
export const REPORT_POLICY = {
  /**
   * Measure vs baseline: raw median, then a signed integer `%` delta in
   * parentheses. Absolute value below 2 is `±0%`. Rates take `pts` instead.
   */
  deltas: 'pct' as const,
  /**
   * When baseline and the best variant both pass every applicable assertion,
   * the headline is `tied-ceiling` on the largest decisive measure delta
   * (absolute value at least 10%), not a `±0 pts` lift.
   */
  tiedCeiling: true,
  /**
   * Two or more variants: one N-arm summary table, then a harness-by-arm effort
   * pivot, then pairwise contrasts.
   */
  variantLayout: 'n-arm' as const,
} as const

export type ReportPolicy = typeof REPORT_POLICY
