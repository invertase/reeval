import { observationsOn } from '../judge/state-options.ts'
import type {
  PlannedQuestion,
  QuestionOptions,
  QuestionStateOptions,
  ResolvedQuestionStateOptions,
} from '../types.ts'

/** The error a per-attempt answer carries when the run stopped before a model answered it. */
export const STOPPED_FIRST = 'the run stopped before it was answered'

/**
 * What a recorded pairwise answer without `stateOptions` showed each side: the task and the diff,
 * every turn's prompt.
 */
export const UNRECORDED_QUESTION_STATE: ResolvedQuestionStateOptions = {
  task: true,
  output: false,
  files: false,
  diff: true,
  transcript: false,
  turns: 'all',
  checks: false,
}

const KEYS = Object.keys(UNRECORDED_QUESTION_STATE) as Array<keyof ResolvedQuestionStateOptions>

/**
 * Every key set, in the record's key order, so equal selections serialize the same: an input the
 * question didn't turn on is off, and `turns` is `'all'` unless it says `'last'`.
 */
export function resolveQuestionState(
  state: QuestionStateOptions | undefined,
): ResolvedQuestionStateOptions {
  const observations = state?.observations
  return {
    task: state?.task ?? false,
    output: state?.output ?? false,
    files: state?.files ?? false,
    diff: state?.diff ?? false,
    transcript: state?.transcript ?? false,
    turns: state?.turns ?? 'all',
    checks: state?.checks ?? false,
    ...(observationsOn(observations) ? { observations } : {}),
  }
}

/** `inner` over `outer`, field by field. */
export function mergeQuestion(
  outer: QuestionOptions,
  inner: QuestionOptions | undefined,
): QuestionOptions {
  return inner ? { ...outer, ...inner } : outer
}

/** A planned question under the cascaded `question` defaults: its own `model`, else theirs. */
export function withQuestionDefaults(
  q: PlannedQuestion,
  defaults: QuestionOptions,
): PlannedQuestion {
  const model = q.model ?? defaults.model
  return model !== undefined ? { ...q, model } : q
}

const isOff = (value: unknown) => value === false || (Array.isArray(value) && !value.length)

/** The inputs a question shows, in order, plus `artifacts` when it sends captures. */
export function questionShows(
  state: ResolvedQuestionStateOptions,
  artifacts: true | string[] | undefined,
): string[] {
  const on = [
    ...KEYS.filter((k) => k !== 'turns' && !isOff(state[k])),
    ...(state.observations ? ['observations'] : []),
  ]
  return artifacts === undefined ? on : [...on, 'artifacts']
}
