import type {
  PlannedQuestion,
  QuestionOptions,
  QuestionStateOptions,
  ResolvedQuestionStateOptions,
} from '../types.ts'

/**
 * What each side of a question shows with no `state`: the task and the diff, every turn's
 * prompt. The final message stays out, since a better-written account of the work would win a
 * side-by-side pick on its wording; the changed files repeat what the diff shows.
 */
export const DEFAULT_QUESTION_STATE: ResolvedQuestionStateOptions = {
  task: true,
  output: false,
  files: false,
  diff: true,
  transcript: false,
  turns: 'all',
  checks: false,
}

const KEYS = Object.keys(DEFAULT_QUESTION_STATE) as Array<keyof ResolvedQuestionStateOptions>

/** Every key set, in `DEFAULT_QUESTION_STATE`'s order, so equal selections serialise the same. */
export function resolveQuestionState(
  state: QuestionStateOptions | undefined,
): ResolvedQuestionStateOptions {
  const out = {} as Record<keyof ResolvedQuestionStateOptions, unknown>
  for (const key of KEYS) out[key] = state?.[key] ?? DEFAULT_QUESTION_STATE[key]
  return out as ResolvedQuestionStateOptions
}

/** `inner` over `outer`: `state` key by key, `artifacts` replaced. */
export function mergeQuestion(
  outer: QuestionOptions,
  inner: QuestionOptions | undefined,
): QuestionOptions {
  if (!inner) return outer
  const out: QuestionOptions = { ...outer, ...inner }
  if (outer.state || inner.state) out.state = { ...outer.state, ...inner.state }
  return out
}

/** A planned question with the cascaded `question` defaults under its own `state` and `artifacts`. */
export function withQuestionDefaults(
  q: PlannedQuestion,
  defaults: QuestionOptions,
): PlannedQuestion {
  const { state, artifacts } = mergeQuestion(defaults, {
    ...(q.state ? { state: q.state } : {}),
    ...(q.artifacts !== undefined ? { artifacts: q.artifacts } : {}),
  })
  const { state: _state, artifacts: _artifacts, ...rest } = q
  return {
    ...rest,
    ...(state && Object.keys(state).length ? { state } : {}),
    ...(artifacts !== undefined ? { artifacts } : {}),
  }
}

const isOff = (value: unknown) => value === false || (Array.isArray(value) && !value.length)

/** True when the resolved state shows nothing and no captures are sent. */
export const showsNothing = (q: PlannedQuestion): boolean => {
  if (q.artifacts !== undefined) return false
  const s = resolveQuestionState(q.state)
  return KEYS.every((k) => k === 'turns' || isOff(s[k]))
}

/** The state keys a question shows, in order, plus `artifacts` when it sends captures. */
export function questionShows(
  state: ResolvedQuestionStateOptions,
  artifacts: true | string[] | undefined,
): string[] {
  const on = KEYS.filter((k) => k !== 'turns' && !isOff(state[k]))
  return artifacts === undefined ? on : [...on, 'artifacts']
}
