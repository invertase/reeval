import type {
  PlannedQuestion,
  QuestionOptions,
  QuestionStateOptions,
  ResolvedQuestionStateOptions,
} from '../types.ts'

/** The error a per-attempt answer carries when the run stopped before a model answered it. */
export const STOPPED_FIRST = 'the run stopped before it was answered'

/**
 * What each side of a pairwise question shows with no `state`: the task and the diff, every
 * turn's prompt. The final message stays out, since a better-written account of the work would
 * win a side-by-side pick on its wording; the changed files repeat what the diff shows.
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

/**
 * What a question asked of each attempt on its own shows with no `state`: the task, the diff,
 * the final message and the transcript. Nothing is weighed against another side, so how the
 * agent went about the work is the point.
 */
export const DEFAULT_ATTEMPT_QUESTION_STATE: ResolvedQuestionStateOptions = {
  ...DEFAULT_QUESTION_STATE,
  output: true,
  transcript: true,
}

const KEYS = Object.keys(DEFAULT_QUESTION_STATE) as Array<keyof ResolvedQuestionStateOptions>

/** A pairwise question's defaults when `pairwise`, a per-attempt question's otherwise. */
export const defaultQuestionState = (pairwise: boolean): ResolvedQuestionStateOptions =>
  pairwise ? DEFAULT_QUESTION_STATE : DEFAULT_ATTEMPT_QUESTION_STATE

/** Every key set, in `DEFAULT_QUESTION_STATE`'s order, so equal selections serialise the same. */
export function resolveQuestionState(
  state: QuestionStateOptions | undefined,
  pairwise: boolean,
): ResolvedQuestionStateOptions {
  const defaults = defaultQuestionState(pairwise)
  const out = {} as Record<keyof ResolvedQuestionStateOptions, unknown>
  for (const key of KEYS) out[key] = state?.[key] ?? defaults[key]
  return out as ResolvedQuestionStateOptions
}

/** `inner` over `outer`: `state` key by key, `model` and `artifacts` replaced. */
export function mergeQuestion(
  outer: QuestionOptions,
  inner: QuestionOptions | undefined,
): QuestionOptions {
  if (!inner) return outer
  const out: QuestionOptions = { ...outer, ...inner }
  if (outer.state || inner.state) out.state = { ...outer.state, ...inner.state }
  return out
}

/** A planned question with the cascaded `question` defaults under its own `model`, `state` and `artifacts`. */
export function withQuestionDefaults(
  q: PlannedQuestion,
  defaults: QuestionOptions,
): PlannedQuestion {
  const { state, artifacts } = mergeQuestion(defaults, {
    ...(q.state ? { state: q.state } : {}),
    ...(q.artifacts !== undefined ? { artifacts: q.artifacts } : {}),
  })
  const { state: _state, artifacts: _artifacts, ...rest } = q
  const model = q.model ?? defaults.model
  return {
    ...rest,
    ...(model !== undefined ? { model } : {}),
    ...(state && Object.keys(state).length ? { state } : {}),
    ...(artifacts !== undefined ? { artifacts } : {}),
  }
}

const isOff = (value: unknown) => value === false || (Array.isArray(value) && !value.length)

/** True when the resolved state shows nothing and no captures are sent. */
export const showsNothing = (q: PlannedQuestion): boolean => {
  if (q.artifacts !== undefined) return false
  const s = resolveQuestionState(q.state, q.across !== undefined)
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
