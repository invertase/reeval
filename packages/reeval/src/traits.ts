// `reeval run --trait` and a profile's `limit.traits`: which planned cells run today, by their
// environment's traits. They narrow after `where` and the cascade; with `compare`, a cell goes by
// its control's traits, so a variant never runs without its control.

import { closest } from './contract/shared.ts'
import { UsageError } from './errors.ts'
import type { PlannedAttempt } from './options.ts'
import type { ResolvedProfile, TraitFilter, Traits } from './types.ts'

/** Parses each `--trait key=value`; refuses one without a key or an `=`. */
export function traitFlags(flags: readonly string[] | undefined): TraitFilter[] {
  return (flags ?? []).map((flag) => {
    const eq = flag.indexOf('=')
    const key = eq === -1 ? '' : flag.slice(0, eq).trim()
    if (!key) {
      throw new UsageError(
        `--trait ${flag} must be key=value, the trait's key and the value a cell's environment has, e.g. --trait lang=ts`,
      )
    }
    return { key, values: [flag.slice(eq + 1)], by: `--trait ${flag}` }
  })
}

/** The run's `--trait` filters, then the profile's `limit.traits`, one per key. */
export function traitFilters(
  flags: readonly TraitFilter[] | undefined,
  profile: ResolvedProfile | null | undefined,
): TraitFilter[] {
  const limit = profile?.limit.traits ?? {}
  return [
    ...(flags ?? []),
    ...Object.entries(limit).map(([key, value]) => ({
      key,
      values: typeof value === 'string' ? [value] : [...value],
      by: `profiles.${profile?.name}.limit.traits.${key}`,
    })),
  ]
}

export const traitsMatch = (traits: Traits | undefined, filters: readonly TraitFilter[]) =>
  filters.every(({ key, values }) => {
    const trait = traits?.[key]
    if (trait === undefined) return false
    return values.some((v) => (typeof trait === 'string' ? trait === v : trait.includes(v)))
  })

/** The trait keys the control cells define: the ones a filter can match. */
export const controlTraitKeys = (attempts: readonly PlannedAttempt[]): string[] => [
  ...new Set(
    attempts
      .filter((a) => a.cell.role === 'control')
      .flatMap((a) => Object.keys(a.cell.traits ?? {})),
  ),
]

export type PickedTraits = {
  kept: PlannedAttempt[]
  /** The environments whose cells it left out, in plan order. */
  excluded: string[]
}

/** Keeps the attempts whose control matches every filter: per harness, the one control. */
export function pickTraits(
  attempts: readonly PlannedAttempt[],
  filters: readonly TraitFilter[],
): PickedTraits {
  const controls = attempts.filter((a) => a.cell.role === 'control')
  const keep = (a: PlannedAttempt) => {
    const control =
      a.cell.role === 'control' ? a : controls.find((c) => c.cell.harness === a.cell.harness)
    return traitsMatch(control?.cell.traits, filters)
  }
  const excluded: string[] = []
  const kept = attempts.filter((a) => {
    if (keep(a)) return true
    if (!excluded.includes(a.cell.environment)) excluded.push(a.cell.environment)
    return false
  })
  return { kept, excluded }
}

/** What the plan says of the filters: `--trait lang=ts, profiles.ci.limit.traits.os`. */
export const filtersLabel = (filters: readonly TraitFilter[]) => filters.map((f) => f.by).join(', ')

/**
 * Refuses a filter whose key no control environment of the run's evals defines: it would leave
 * every cell out. `known` are the keys the evals the tags select define, across the files.
 */
export function checkTraitKeys(filters: readonly TraitFilter[], known: readonly string[]): void {
  const have = [...known].sort()
  for (const f of filters) {
    if (have.includes(f.key)) continue
    const near = closest(f.key, have)
    throw new UsageError(
      `${f.by}: no control environment of the run's evals defines the trait ${f.key} (${have.length ? `they define: ${have.join(', ')}` : 'none defines any'}).${near ? ` Did you mean "${near}"?` : ''}`,
    )
  }
}
