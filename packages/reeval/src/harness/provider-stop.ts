import { InfraError } from '../sandbox/types.ts'
import type { ProviderStopRecord, TurnStatus } from '../types.ts'

type Cause = ProviderStopRecord['cause']

/**
 * How the model APIs behind the harnesses, and the CLIs that relay them, word a stop that is
 * theirs, not the agent's: Anthropic's low credit (an HTTP 400) and error types, OpenAI's and
 * OpenRouter's quota and credit codes, xAI's spent credits (an HTTP 403 or 429), Google's
 * `RESOURCE_EXHAUSTED` and overloaded model, Codex's quota and capacity errors and Cursor's and
 * Codex's usage limit. Only the providers' own codes and sentences: a bare "rate limit" or
 * "overloaded" can be any tool's output in the CLI's stderr.
 */
const WORDING: ReadonlyArray<readonly [Cause, RegExp]> = [
  [
    'credit',
    /\bcredit balance is too low\b|\binsufficient[_ ]credits?\b|\b402 Payment Required\b|\bused all available credits\b|\breached its monthly spending limit\b/i,
  ],
  [
    'quota',
    /\binsufficient_quota\b|\bexceeded your current quota\b|\bQuota exceeded\. Check your plan and billing details\b|\bRESOURCE_EXHAUSTED\b|\b(?:hit your|exceeded the) usage limit\b|\busage limit exceeded\b/i,
  ],
  ['rate_limit', /\brate_limit_error\b|\brate_limit_exceeded\b|\b429 Too Many Requests\b/i],
  [
    'overloaded',
    /\boverloaded_error\b|\bThe model is overloaded\b|\bSelected model is at capacity\b/i,
  ],
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
 * Whether the model provider, not the agent, ended the turn: it errored, and one of its errors
 * (in the provider's own wording) or the status of the last model call the egress gateway
 * brokered in it (402, 429, 529) says it was a credit, quota, rate or capacity limit. The wording
 * counts whatever that call's status: a provider that fails a streamed response does it inside
 * an HTTP 200 (Anthropic's and OpenAI's SSE, Cursor's Connect stream). A status alone counts only
 * on the turn's last brokered call, so a 429 the CLI retried past is the agent's.
 */
export function providerStop(turn: {
  errors: readonly string[]
  status: TurnStatus
  statuses: readonly number[]
}): ProviderStop | undefined {
  const { errors, status, statuses } = turn
  if (status !== 'error') return undefined
  const last = statuses.at(-1)
  const failed = last !== undefined && last >= 400 ? last : undefined
  const worded = errors.flatMap((message) => {
    const hit = WORDING.find(([, re]) => re.test(message))
    return hit ? [{ cause: hit[0], message }] : []
  })[0]
  const cause = worded?.cause ?? (failed === undefined ? undefined : STATUS.get(failed))
  if (!cause) return undefined
  const error = worded?.message ?? errors.at(-1)
  const http = failed === undefined ? '' : ` (HTTP ${failed})`
  return {
    cause,
    status: failed ?? null,
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
