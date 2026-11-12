import type { CompareStatus } from '../compare.ts'
import type { MeasureKey } from './types.ts'

/** Product labels for measure keys; never print the enum key in report copy. */
export const MEASURE_LABEL: Record<MeasureKey, string> = {
  tokens: 'Tokens',
  toolCalls: 'Tool calls',
  turns: 'Turns',
  costUsd: 'Cost',
  agentMs: 'Agent time',
  filesChanged: 'Files changed',
  linesAdded: 'Lines added',
  linesRemoved: 'Lines removed',
}

export const VERDICT_LABEL = {
  baseline: 'Baseline',
  helped: 'Helped',
  'made-worse': 'Made worse',
  'within-noise': 'Within noise',
  'too-few-runs': 'Too few runs',
  fewer: 'Fewer',
  more: 'More',
} as const

export const COMPARE_STATUS_LABEL: Record<CompareStatus, string> = {
  same: 'Unchanged',
  regressed: 'Worse',
  fixed: 'Fixed',
  gate: 'Gate',
  drift: 'Drift',
  added: 'Added',
  removed: 'Removed',
  infra: 'Infra',
}

export const DISCOVERY_SOURCE_LABEL = {
  placed: 'Placed skill',
  'skill-dir': 'Skill directory',
  elsewhere: 'Elsewhere',
  mcp: 'MCP',
  web: 'Web',
} as const

export const PASS_RATE_OUTCOME_LABEL = {
  passed: 'passed',
  found: 'found',
  used: 'used',
} as const

export type PassRateOutcome = keyof typeof PASS_RATE_OUTCOME_LABEL

/** Lowercase measure phrase for mid-sentence use (`lines added`). */
export function measurePhrase(key: MeasureKey): string {
  return MEASURE_LABEL[key].toLowerCase()
}

export function contrastMeasureLabel(measure: 'pass-rate' | MeasureKey): string {
  return measure === 'pass-rate' ? 'Pass rate' : MEASURE_LABEL[measure]
}

export function verdictLabel(verdict: keyof typeof VERDICT_LABEL | string): string {
  return (VERDICT_LABEL as Record<string, string>)[verdict] ?? verdict
}

export function compareStatusLabel(status: CompareStatus): string {
  return COMPARE_STATUS_LABEL[status]
}

export function discoverySourceLabel(source: keyof typeof DISCOVERY_SOURCE_LABEL): string {
  return DISCOVERY_SOURCE_LABEL[source]
}

/**
 * Infer a discoverability outcome noun from assertion matchers on the eval.
 * Prefer `used` when a use/call matcher is present; else `found` for find/read/fetch.
 */
export function passRateOutcomeFromMatchers(matchers: string[]): PassRateOutcome | null {
  const used = matchers.some((m) => /toHaveCalledSkill|toHaveCalledMcp|toHaveUsed/i.test(m))
  if (used) return 'used'
  const found = matchers.some((m) =>
    /toHaveFetched|toHaveReadSkill|toHaveFound|toHaveOpened/i.test(m),
  )
  if (found) return 'found'
  return null
}
