import type { VmApi, VmInfo } from './types.ts'

const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })

/** Why {@link waitReady} gave up: the machine died, or wasn't ready in time. */
export class VmNotReady extends Error {
  override readonly name = 'VmNotReady'
  /** Its last report, or null once it was gone. */
  readonly last: VmInfo | null
  readonly reason: 'dead' | 'gone' | 'timeout'
  constructor(message: string, reason: VmNotReady['reason'], last: VmInfo | null) {
    super(message)
    this.reason = reason
    this.last = last
  }
}

/**
 * Polls `id` until it's ready and returns it; throws {@link VmNotReady} once it's dead, gone or
 * still not ready after `timeoutMs`, and `signal`'s reason once that aborts.
 */
export async function waitReady(
  api: VmApi,
  id: string,
  o: { timeoutMs: number; pollMs?: number; signal?: AbortSignal },
): Promise<VmInfo> {
  const deadline = Date.now() + o.timeoutMs
  for (;;) {
    const vm = await api.get(id, o.signal ? { signal: o.signal } : {})
    if (!vm) throw new VmNotReady(`sandbox ${id} is gone`, 'gone', null)
    if (vm.state === 'ready') return vm
    if (vm.state === 'dead') {
      throw new VmNotReady(
        `sandbox ${id} stopped starting: ${vm.raw}${vm.error ? ` (${vm.error})` : ''}`,
        'dead',
        vm,
      )
    }
    if (Date.now() > deadline) {
      throw new VmNotReady(
        `sandbox ${id} wasn't ready after ${o.timeoutMs / 1000}s (still ${vm.raw})`,
        'timeout',
        vm,
      )
    }
    o.signal?.throwIfAborted()
    await pause(o.pollMs ?? 300, o.signal)
    o.signal?.throwIfAborted()
  }
}

/**
 * Deletes a machine that may still be starting, sending the delete again every `redeleteMs` until
 * it's gone or dead, for at most `deadlineMs`: a provider can drop a delete sent while it
 * provisions and bring the machine up minutes later. Once `signal` aborts it stops after the
 * delete in flight. Whether it went.
 */
export async function removeUntilGone(
  api: VmApi,
  id: string,
  o: { deadlineMs?: number; pollMs?: number; redeleteMs?: number; signal?: AbortSignal } = {},
): Promise<boolean> {
  const until = Date.now() + (o.deadlineMs ?? 10 * 60_000)
  const pollMs = o.pollMs ?? 5_000
  const redeleteMs = o.redeleteMs ?? 30_000
  let deletedAt = Number.NEGATIVE_INFINITY
  for (;;) {
    if (Date.now() - deletedAt >= redeleteMs) {
      await api.remove(id).catch(() => {})
      deletedAt = Date.now()
    }
    if (o.signal?.aborted) return false
    const state = await api.get(id).then(
      (vm) => vm?.state ?? null,
      () => 'unknown',
    )
    if (state === null || state === 'dead') return true
    if (Date.now() >= until || o.signal?.aborted) return false
    await pause(pollMs, o.signal)
  }
}
