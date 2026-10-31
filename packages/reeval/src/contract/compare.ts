// The compare option's plain-data contract: the control, its variants and how they gate.
// Environments in it are checked by whichever schema the caller passes (an
// `Environment` from `defineEnvironment`, or environment data from another language).
import { z } from 'zod'
import { isObjectLike } from '../object.ts'
import type { CompareGate, CompareOptions, Environment, HarnessDescriptor } from '../types.ts'
import { FACTORY, harnessDescriptorSchema, harnessProblem } from './harness.ts'
import { type Assert, type Issue, oneOf, refusal, type Same } from './shared.ts'

export const compareGateSchema = z.enum(['variants', 'all', 'none'])

/** The compare object, with environments checked by `environment`. */
export const compareSchema = <E extends z.ZodType>(environment: E) =>
  z.strictObject({
    baseline: environment.optional(),
    variants: z.array(environment).min(1),
    gate: compareGateSchema.optional(),
    minLift: z.number().min(-1).max(1).optional(),
    harnesses: z.array(z.union([z.string(), harnessDescriptorSchema])).optional(),
  })

const authoredCompare = compareSchema(z.custom<Environment>())

export type _SameAsSchema = [
  Assert<Same<z.infer<typeof compareGateSchema>, CompareGate>>,
  Assert<Same<z.infer<typeof authoredCompare>, CompareOptions<Environment>>>,
  Assert<Same<keyof z.infer<typeof authoredCompare>, keyof CompareOptions<Environment>>>,
]

const describe = (value: unknown) => {
  if (Array.isArray(value)) return `a list of ${value.length}`
  if (typeof value === 'object' && value !== null) {
    const keys = Object.keys(value)
    return keys.length ? `an object with ${keys.map((k) => `"${k}"`).join(', ')}` : 'an object'
  }
  return JSON.stringify(value) ?? String(value)
}

function explain(where: string) {
  return (issue: Issue, value: unknown): string => {
    const spec = value as Record<string, unknown>
    if (issue.code === 'unrecognized_keys' && issue.path.length === 0) {
      const key = issue.keys[0] as string
      return `Unknown compare option "${key}" in ${where}. compare takes ${Object.keys(compareSchema(z.any()).shape).join(', ')}.`
    }
    const [key, index] = issue.path as [string, number?]
    const v = spec[key]
    switch (key) {
      case 'baseline':
        return `compare.baseline in ${where} must be an environment from defineEnvironment (got ${describe(v)}). It is the control; variants are not layered on it or on the eval's environment. Leave it out to use the eval's environments as the control.`
      case 'gate':
        return `compare.gate in ${where} is ${oneOf(compareGateSchema.options)} (got ${describe(v)})`
      case 'minLift':
        return `compare.minLift in ${where} is points from -1 to 1, e.g. minLift: 0.1 (got ${describe(v)})`
      case 'harnesses': {
        const item = index === undefined ? undefined : (v as unknown[])[index]
        const kind = (item as { kind?: string } | null)?.kind
        const problem =
          kind && kind in FACTORY ? harnessProblem(item as HarnessDescriptor) : undefined
        return problem
          ? `compare.harnesses in ${where}: ${problem}`
          : `compare.harnesses in ${where} must be a list of harness ids, e.g. harnesses: ['cursor:composer-2.5'] (got ${describe(index === undefined ? v : item)})`
      }
      default:
        return index === undefined
          ? `compare has no variants in ${where}. Give at least one environment.`
          : `compare.variants in ${where} must be environments from defineEnvironment (got ${describe((v as unknown[])[index])}). Variants share the eval's prompt and checks; if a variant needs different checks, write a separate eval.`
    }
  }
}

/** The order the hand-written checks ran in, so the first refusal stays the same. */
const ORDER = ['baseline', 'gate', 'minLift', 'harnesses', 'variants']

/**
 * What's wrong with a compare object whose environments `environment` checks, or undefined.
 * `where` names the group or eval it's set on.
 */
export function compareProblem(value: unknown, where: string, environment: z.ZodType) {
  if (Array.isArray(value)) {
    return `compare in ${where} must be an object, not a list. Use compare: { baseline, variants: [...] }.`
  }
  if (!isObjectLike(value) || !Array.isArray(value.variants)) {
    return `compare in ${where} takes { variants, baseline? } (got ${describe(value)}). Use compare: { variants: [a, b], baseline?, gate?, minLift?, harnesses? }.`
  }
  return refusal(compareSchema(environment), value, explain(where), { order: ORDER })
}
