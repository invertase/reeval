// `where` on an eval with cases: which case and environment pairs run, decided at plan time over
// one case's planned attempts. With `compare`, the control's answer holds for every variant on
// its harness, so each variant runs the same cases.

import { closest } from './contract/shared.ts'
import { traitsOf } from './environment.ts'
import { UsageError } from './errors.ts'
import type { PlannedAttempt } from './options.ts'
import type { ExcludedPair, Where } from './types.ts'

/** One case's `where`, as `planEval` gets it. */
export type CaseWhere = {
  /** The eval, as refusals name it: `evaluate("x")`. */
  label: string
  key: string
  item: unknown
  where: Where<unknown>
}

/** One case's attempts after `where`: the ones kept, and the pairs it left out. */
export type PickedPairs = {
  kept: PlannedAttempt[]
  excluded: ExcludedPair[]
  /** Every cell key before `where`, then the ones it kept, for the eval-wide checks. */
  cells: Array<{ key: string; environment: string }>
  keptCells: string[]
}

/** Keys a trait lookup can hit without naming a trait: JSON, promises and inspection. */
const PASSTHROUGH = new Set(['toJSON', 'then', 'constructor'])

export function pickPairs(w: CaseWhere, attempts: PlannedAttempt[]): PickedPairs {
  const controls = attempts.filter((a) => a.cell.role === 'control')
  const known = [...new Set(controls.flatMap((a) => Object.keys(traitsOf(a.environment.layers))))]
  const decisions = new Map<string, { keep: boolean; readHarness: boolean }>()
  const decide = (control: PlannedAttempt) => {
    const id = control.cell.key
    const made = decisions.get(id)
    if (made) return made
    const env = control.environment
    const traits = traitsOf(env.layers)
    let readHarness = false
    const view = new Proxy(traits, {
      get(target, key, receiver) {
        if (typeof key === 'string' && !(key in target) && !PASSTHROUGH.has(key)) {
          if (!known.includes(key)) {
            const near = closest(key, known)
            throw new UsageError(
              `${w.label}'s where reads environment.traits.${key}, which no environment defines (${known.length ? `they define: ${known.join(', ')}` : 'none defines any'}).${near ? ` Did you mean "${near}"?` : ''}`,
            )
          }
        }
        return Reflect.get(target, key, receiver)
      },
    })
    const pair = {
      case: w.item,
      environment: Object.freeze({ name: env.name, traits: view }),
      get harness() {
        readHarness = true
        return control.cell.harness
      },
    }
    let result: unknown
    try {
      result = w.where(pair)
    } catch (error) {
      if (error instanceof UsageError) throw error
      const why = error instanceof Error ? error.message : String(error)
      throw new UsageError(`${w.label}'s where threw for case ${w.key} on ${env.name}: ${why}`)
    }
    if (typeof result !== 'boolean') {
      throw new UsageError(
        `${w.label}'s where returned ${JSON.stringify(result) ?? String(result)} for case ${w.key} on ${env.name}; it must return true or false.`,
      )
    }
    const decided = { keep: result, readHarness }
    decisions.set(id, decided)
    return decided
  }
  const controlOf = (a: PlannedAttempt) =>
    a.cell.role === 'control'
      ? a
      : (controls.find((c) => c.cell.harness === a.cell.harness) as PlannedAttempt)
  const cells: PickedPairs['cells'] = []
  const keptCells: string[] = []
  const excluded: ExcludedPair[] = []
  const kept = attempts.filter((a) => {
    const { keep, readHarness } = decide(controlOf(a))
    const first = !cells.some((c) => c.key === a.cell.key)
    if (first) cells.push({ key: a.cell.key, environment: a.cell.environment })
    if (keep) {
      if (first) keptCells.push(a.cell.key)
      return true
    }
    const pair: ExcludedPair = {
      case: w.key,
      environment: a.cell.environment,
      ...(readHarness ? { harness: a.cell.harness } : {}),
    }
    if (!excluded.some((e) => e.environment === pair.environment && e.harness === pair.harness)) {
      excluded.push(pair)
    }
    return false
  })
  return { kept, excluded, cells, keptCells }
}
