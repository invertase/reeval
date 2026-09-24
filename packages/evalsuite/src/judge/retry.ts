import { setTimeout as sleep } from 'node:timers/promises'
import type { JudgeRetry } from '../history/types.ts'

/** Internal: how hard a judge call tries before it fails the eval. Not user config. */
export type RetryPolicy = { attempts: number; baseMs: number; maxMs: number }

/** Up to six tries over about a minute: long enough to ride out a provider's "high demand". */
export const JUDGE_RETRY: RetryPolicy = { attempts: 6, baseMs: 2_000, maxMs: 30_000 }

const TRANSIENT_STATUS = new Set([408, 409, 425, 429])
const TRANSIENT_MESSAGE =
  /high demand|overloaded|unavailable|rate.?limit|resource.?exhausted|try again|timed? ?out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed/i

type ProviderError = {
  statusCode?: number
  isRetryable?: boolean
  responseHeaders?: Record<string, string>
  lastError?: unknown
}

/** The AI SDK wraps the provider's error once it has retried itself; look through that. */
const innermost = (error: unknown): unknown => {
  const e = error as ProviderError & { name?: string }
  return e?.name === 'AI_RetryError' && e.lastError ? innermost(e.lastError) : error
}

/** Rate limits, 5xx, overload and network blips. Never a bad request, bad key or abort. */
export function isTransient(error: unknown): boolean {
  const e = innermost(error) as ProviderError & Error
  if (!e || e.name === 'AbortError') return false
  if (typeof e.statusCode === 'number') {
    return e.statusCode >= 500 || TRANSIENT_STATUS.has(e.statusCode) || e.isRetryable === true
  }
  return e.isRetryable === true || TRANSIENT_MESSAGE.test(e.message ?? String(e))
}

function retryAfterMs(error: unknown): number {
  const header = (innermost(error) as ProviderError)?.responseHeaders?.['retry-after']
  const seconds = Number(header)
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0
}

/** Exponential backoff with equal jitter, at least any `retry-after`, never above `maxMs`. */
export function backoffMs(policy: RetryPolicy, retry: number, error: unknown): number {
  const cap = Math.min(policy.maxMs, policy.baseMs * 2 ** retry)
  const jittered = cap / 2 + Math.random() * (cap / 2)
  return Math.round(Math.min(policy.maxMs, Math.max(jittered, retryAfterMs(error))))
}

export type RetriedError = Error & { retries: JudgeRetry[] }

/** Runs `call` until it succeeds, fails for good, or runs out of tries. */
export async function withRetries<T>(
  call: () => Promise<T>,
  policy: RetryPolicy,
  signal: AbortSignal,
): Promise<{ value: T; retries: JudgeRetry[] }> {
  const retries: JudgeRetry[] = []
  for (;;) {
    try {
      return { value: await call(), retries }
    } catch (error) {
      if (signal.aborted || retries.length + 1 >= policy.attempts || !isTransient(error)) {
        const failed = (error instanceof Error ? error : new Error(String(error))) as RetriedError
        failed.retries = retries
        throw failed
      }
      const delayMs = backoffMs(policy, retries.length, error)
      const e = innermost(error) as Error
      retries.push({ error: e?.message ?? String(e), delayMs })
      await sleep(delayMs, undefined, { signal })
    }
  }
}
