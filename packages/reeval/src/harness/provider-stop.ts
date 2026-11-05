import { InfraError } from '../sandbox/types.ts'
import type { ProviderStopRecord, TurnStatus } from '../types.ts'

type Cause = ProviderStopRecord['cause']

/**
 * How the model APIs behind the harnesses word a stop that is theirs, not the agent's: Anthropic's
 * low credit (an HTTP 400) and error types, OpenAI's and OpenRouter's quota and credit codes,
 * Google's `RESOURCE_EXHAUSTED` and Cursor's usage limit. Only the providers' own codes and
 * sentences: a bare "rate limit" or "overloaded" can be any tool's output in the CLI's stderr.
 */
const WORDING: ReadonlyArray<readonly [Cause, RegExp]> = [
  [
    'credit',
    /\bcredit balance is too low\b|\binsufficient[_ ]credits?\b|\b402 Payment Required\b/i,
  ],
  [
    'quota',
    /\binsufficient_quota\b|\bexceeded your current quota\b|\bRESOURCE_EXHAUSTED\b|\b(?:hit your|exceeded the) usage limit\b|\busage limit exceeded\b/i,
  ],
  ['rate_limit', /\brate_limit_error\b|\brate_limit_exceeded\b|\b429 Too Many Requests\b/i],
  ['overloaded', /\boverloaded_error\b/i],
]

/** The statuses a provider stops a turn with: payment, its rate or quota limit, Anthropic's overload. */
const STATUS: ReadonlyMap<number, Cause> = new Map([
  [402, 'credit'],
  [429, 'rate_limit'],
  [529, 'overloaded'],
])

const CAUSE_TEXT: Record<Cause, string> = {
  credit: 'out of credit',
  quota: 'over its quota',
  rate_limit: 'rate limited',
  overloaded: 'overloaded',
}

/** A turn the model provider stopped, with the message the attempt's infra error carries. */
export type ProviderStop = ProviderStopRecord & { message: string }

/**
 * Whether the model provider, not the agent, ended the turn: it errored, the last model call the
 * egress gateway brokered in it failed (or none was brokered), and that call's status (402, 429,
 * 529) or one of the turn's errors (in the provider's own wording) says it was a credit, quota,
 * rate or capacity limit. A turn that recovered, whose last brokered call succeeded, is the agent's,
 * whatever its errors say: a 429 the CLI retried past, or the wording in a tool's output.
 */
export function providerStop(turn: {
  errors: readonly string[]
  status: TurnStatus
  statuses: readonly number[]
}): ProviderStop | undefined {
  const { errors, status, statuses } = turn
  if (status !== 'error') return undefined
  const last = statuses.at(-1)
  if (last !== undefined && last < 400) return undefined
  const worded = errors.flatMap((message) => {
    const hit = WORDING.find(([, re]) => re.test(message))
    return hit ? [{ cause: hit[0], message }] : []
  })[0]
  const byStatus = last === undefined ? undefined : STATUS.get(last)
  const cause = worded?.cause ?? byStatus
  if (!cause) return undefined
  const error = worded?.message ?? errors.at(-1)
  const http = last === undefined ? '' : ` (HTTP ${last})`
  return {
    cause,
    status: last ?? null,
    message: `The model provider stopped the turn, ${CAUSE_TEXT[cause]}${http}${error ? `: ${error.trim()}` : ''}`,
  }
}

/** A turn the provider stopped, as the infra error that fails the attempt. */
export class ProviderStopError extends InfraError {
  readonly stop: ProviderStopRecord
  constructor({ message, ...stop }: ProviderStop) {
    super(message)
    this.stop = stop
  }
}
