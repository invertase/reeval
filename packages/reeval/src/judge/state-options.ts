import type { JudgeCallFields, JudgeOptions, ResolvedJudgeStateOptions } from '../types.ts'

/**
 * What one call turned on, every key set (`false` when off), in the record's key order, so equal
 * selections serialize the same.
 */
export function resolveStateOptions(call: JudgeCallFields): ResolvedJudgeStateOptions {
  const { observations } = call
  return {
    task: call.task ?? false,
    output: call.output ?? false,
    files: call.files ?? false,
    diff: call.diff ?? false,
    contents: call.contents ?? [],
    transcript: call.transcript ?? false,
    turns: call.turns ?? 'last',
    checks: call.checks ?? false,
    ...(observationsOn(observations) ? { observations } : {}),
  }
}

/** `observations` when it turns the input on: `true` or a non-empty list. */
export const observationsOn = (value: boolean | string[] | undefined): value is true | string[] =>
  value === true || (Array.isArray(value) && value.length > 0)

/** `inner` over `outer`, field by field. */
export function mergeJudge<T extends JudgeOptions>(outer: T, inner: Partial<T> | undefined): T {
  return inner ? { ...outer, ...inner } : outer
}
