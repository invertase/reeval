// Labels for a pooled `evaluate.each`, shared by the terminal, summary.md and the studio.
import type {
  EvalEntry,
  FamilyEffortMetric,
  FamilyLift,
  FamilyRate,
  FamilyRecord,
} from '../history/types.ts'

const signed = (x: number) => `${x >= 0 ? '+' : '−'}${Math.round(Math.abs(x) * 100)}`
const pct = (x: number) => `${Math.round(x * 100)}%`
const pValue = (p: number) => (p < 0.001 ? '<0.001' : String(p))

/** `pass@1 2/3 · 67% (95% 21…94)`, or `pass@1 67% over 3 cases (95% 30…100)` at several runs. */
export function familyRateLabel(rate: FamilyRate): string {
  const { interval: i } = rate
  const range = `95% ${Math.round(i.lo * 100)}…${Math.round(i.hi * 100)}`
  return i.method === 'wilson'
    ? `pass@1 ${rate.pass}/${rate.counted} · ${pct(rate.rate)} (${range})`
    : `pass@1 ${pct(rate.rate)} over ${rate.cases} cases (${range})`
}

const VERDICT_NOTE: Record<FamilyLift['verdict'], string> = {
  lift: '',
  drop: '',
  noise: ', within noise',
  insufficient: ', insufficient',
}

/**
 * `pass@1 88% vs 20%  lift +68 pts (95% +40…+82, paired, 18 vs 1 discordant, p <0.001)`. At
 * one attempt a case, the counts are the discordant pairs; at several, the paired cases.
 */
export function familyLiftLabel(lift: FamilyLift): string {
  const { interval: i } = lift
  const range = `95% ${signed(i.lo)}…${signed(i.hi)}`
  const pairs = lift.discordant
    ? `${lift.discordant.variantOnly} vs ${lift.discordant.controlOnly} discordant`
    : `${lift.pairs} cases`
  const p = lift.p === null ? '' : `, p ${pValue(lift.p)}`
  const rates = `pass@1 ${pct(lift.variantRate)} vs ${pct(lift.controlRate)}`
  return `${rates}  lift ${signed(lift.points)} pts (${range}, paired, ${pairs}${p})${VERDICT_NOTE[lift.verdict]}`
}

const metricText = (name: string, m: FamilyEffortMetric | undefined) =>
  !m || m.ratio === null
    ? []
    : [
        `${name} ×${m.ratio.toFixed(2)} per case (${m.verdict}${m.p === null ? '' : `, signed-rank p ${pValue(m.p)}`})`,
      ]

/**
 * `tools ×0.41 per case (fewer, signed-rank p 0.002) · agent time ×0.80 per case (noise, …)`;
 * a metric whose control median is 0 has no ratio and is left out.
 */
export function familyEffortLabel(lift: FamilyLift): string | null {
  const e = lift.effort
  if (!e) return null
  const parts = [
    ...metricText('tools', e.tools),
    ...metricText('agent time', e.agentMs),
    ...metricText('tokens', e.tokens),
  ]
  return parts.length ? parts.join(' · ') : null
}

/** `25 cases · paired` with a compare, and `3 of 25 cases` when a filter left some out. */
export function familyHeadLabel(family: FamilyRecord): string {
  const cases =
    family.ran === family.cases ? `${family.cases} cases` : `${family.ran} of ${family.cases} cases`
  return family.lifts.length ? `${cases} · paired` : cases
}

/**
 * A case's short label: its name less the template's literal text before the first placeholder
 * and after the last, so `fixes $id` labels `fixes GH-101` as `GH-101`.
 */
export function caseLabel(template: string, name: string): string {
  const placeholder = /%#|%s|\$[A-Za-z_][A-Za-z0-9_]*/g
  const matches = [...template.matchAll(placeholder)]
  const first = matches[0]
  const last = matches.at(-1)
  if (!first || !last) return name
  const prefix = template.slice(0, first.index)
  const suffix = template.slice((last.index ?? 0) + last[0].length)
  if (!name.startsWith(prefix) || !name.endsWith(suffix)) return name
  const label = name.slice(prefix.length, name.length - suffix.length)
  return label || name
}

/** The family's cases in list order. */
export const familyCases = (family: Pick<FamilyRecord, 'id'>, evals: readonly EvalEntry[]) =>
  evals
    .filter((e) => e.family?.id === family.id)
    .sort((a, b) => (a.family?.case ?? 0) - (b.family?.case ?? 0))
