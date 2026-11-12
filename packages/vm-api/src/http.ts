import { retryAtOf, VmApiError, type VmErrorKind } from './errors.ts'
import type { VmProviderId } from './types.ts'

/** How a provider says what went wrong, which turns its failed responses into {@link VmApiError}s. */
export type Failures = {
  provider: VmProviderId
  /** The provider's code and words for a failed call's body. */
  describe(status: number, body: unknown, text: string): { code: string; message: string }
  /** What a failed call (`label`: `create`, `get <id>`, …) means. */
  classify(
    status: number,
    code: string,
    body: unknown,
    label: string,
  ): { kind: VmErrorKind; retryable: boolean }
}

export const DEFAULT_TIMEOUT_MS = 30_000

/** A failed response as a {@link VmApiError}. */
export function responseError(
  f: Failures,
  label: string,
  status: number,
  text: string,
  retryAfter: string | null,
): VmApiError {
  let body: unknown
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    body = undefined
  }
  const { code, message } = f.describe(status, body, text)
  const { kind, retryable } = f.classify(status, code, body, label)
  const retryAt =
    kind === 'rate-limited' || kind === 'capacity' || kind === 'quota'
      ? retryAtOf(body, retryAfter, message)
      : undefined
  return new VmApiError({
    provider: f.provider,
    label,
    status,
    code,
    kind,
    retryable,
    ...(retryAt !== undefined && { retryAt }),
    detail: `${status}${message ? ` ${message}` : ''}`,
  })
}

/** A call that got no response. */
export const networkError = (provider: VmProviderId, label: string, why: string) =>
  new VmApiError({
    provider,
    label,
    status: 0,
    code: 'network',
    kind: 'network',
    retryable: true,
    detail: why,
  })

/** An answer this package can't read. */
export const shapeError = (provider: VmProviderId, label: string, why: string) =>
  new VmApiError({
    provider,
    label,
    status: 200,
    code: 'unexpected_shape',
    kind: 'unknown',
    retryable: false,
    detail: why,
  })

/** {@link VmApiError}'s 404 as null. */
export async function orNull<T>(run: Promise<T>): Promise<T | null> {
  try {
    return await run
  } catch (error) {
    if (error instanceof VmApiError && error.status === 404) return null
    throw error
  }
}

/** The generic meaning of a status, which an adapter's own classify narrows. */
export function kindOfStatus(status: number): { kind: VmErrorKind; retryable: boolean } {
  if (status === 401) return { kind: 'auth', retryable: false }
  if (status === 403) return { kind: 'auth', retryable: false }
  if (status === 404) return { kind: 'not-found', retryable: false }
  if (status === 409) return { kind: 'conflict', retryable: false }
  if (status === 429) return { kind: 'rate-limited', retryable: true }
  if (status === 503) return { kind: 'capacity', retryable: true }
  if (status >= 500) return { kind: 'unknown', retryable: true }
  if (status >= 400) return { kind: 'invalid', retryable: false }
  return { kind: 'unknown', retryable: false }
}
