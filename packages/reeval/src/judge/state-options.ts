import { STATE_KEYS } from '../contract/judge.ts'
import type { JudgeOptions, JudgeStateOptions, ResolvedJudgeStateOptions } from '../types.ts'

export const DEFAULT_STATE: ResolvedJudgeStateOptions = {
  task: true,
  output: true,
  files: true,
  diff: true,
  contents: [],
  transcript: false,
  turns: 'last',
  checks: false,
}

/** Every key set, in `STATE_KEYS` order, so equal selections serialize the same. */
export function resolveStateOptions(
  state: JudgeStateOptions | undefined,
): ResolvedJudgeStateOptions {
  const out = {} as Record<keyof JudgeStateOptions, unknown>
  for (const key of STATE_KEYS) out[key] = state?.[key] ?? DEFAULT_STATE[key]
  return out as ResolvedJudgeStateOptions
}

/** `inner` over `outer`, field by field, and `state` key by key. */
export function mergeJudge<T extends JudgeOptions>(outer: T, inner: Partial<T> | undefined): T {
  if (!inner) return outer
  const out = { ...outer, ...inner }
  if (outer.state || inner.state) out.state = { ...outer.state, ...inner.state }
  return out
}
