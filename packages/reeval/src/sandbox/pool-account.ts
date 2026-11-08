// One provider account's limits, shared by the run's pools on it: a pool per machine size and
// image, each with its own machines and slots, while the account counts every machine they hold
// and holds every start to its windows. A pool that needs a machine when the account has none to
// spare has the machine idle longest in another pool removed.
import PQueue from 'p-queue'
import { InfraError } from './types.ts'

/** How many machines and starts the provider allows the account. */
export type PoolLimits = {
  /** The most machines at once. */
  machines: number
  /** Starts in any 60 s, when the provider caps them. */
  startsPerMinute?: number | null
  /** Starts in any hour, counting the ones the account made before this run. */
  startsPerHour?: number | null
  /** Starts left for the rest of the run, when the provider limits them run-wide. */
  starts?: number | null
}

/** How long a pool waits out a provider's rate limits, unless its options say otherwise. */
export const RATE_LIMIT_WAITS = {
  maxRateWaitMs: 15 * 60_000,
  backoffMs: 5_000,
  maxBackoffMs: 60_000,
} as const

export type AccountOptions = {
  limits: PoolLimits
  /** The first wait after a rate limit that named none, doubling to `maxBackoffMs`. Default 5 s. */
  backoffMs?: number
  /** Default 60 s. */
  maxBackoffMs?: number
  /** The windows `startsPerMinute` and `startsPerHour` count in. Default a minute and an hour. */
  windowsMs?: { minute: number; hour: number }
}

/** A pool on the account, as the account sees it. */
export type AccountMember = {
  /** This pool's machine idle longest, with when it went idle, or null when none is. */
  idlest(): { since: number; evict(): void } | null
}

export class PoolAccount {
  readonly helper: string
  readonly limits: PoolLimits
  readonly #members = new Set<AccountMember>()
  readonly #waiters = new Set<() => void>()
  readonly #queues: PQueue[] = []
  readonly #backoff: { first: number; max: number }
  #machines = 0
  #startsLeft: number | null
  #backoffMs: number
  #heldUntil = 0
  #held: NodeJS.Timeout | undefined

  constructor(helper: string, options: AccountOptions) {
    this.helper = helper
    this.limits = options.limits
    this.#backoff = {
      first: options.backoffMs ?? RATE_LIMIT_WAITS.backoffMs,
      max: options.maxBackoffMs ?? RATE_LIMIT_WAITS.maxBackoffMs,
    }
    this.#backoffMs = this.#backoff.first
    this.#startsLeft = options.limits.starts ?? null
    const { startsPerMinute, startsPerHour } = options.limits
    const windowsMs = options.windowsMs ?? { minute: 60_000, hour: 3_600_000 }
    for (const [cap, interval] of [
      [startsPerHour, windowsMs.hour],
      [startsPerMinute, windowsMs.minute],
    ] as const) {
      if (cap === null || cap === undefined) continue
      this.#queues.push(
        new PQueue({
          concurrency: Number.POSITIVE_INFINITY,
          intervalCap: Math.max(1, cap),
          interval,
          strict: true,
        }),
      )
    }
    // A rate limit holds every start, so there's a queue to pause even with no caps to keep.
    if (!this.#queues.length)
      this.#queues.push(new PQueue({ concurrency: Number.POSITIVE_INFINITY }))
  }

  join(member: AccountMember): void {
    this.#members.add(member)
  }

  leave(member: AccountMember): void {
    this.#members.delete(member)
  }

  /** Takes room for one machine, or returns false when the account has none to spare. */
  reserve(): boolean {
    if (this.#machines >= Math.max(1, this.limits.machines)) return false
    this.#machines++
    return true
  }

  /** A machine `reserve` made room for has gone. */
  free(): void {
    this.#machines = Math.max(0, this.#machines - 1)
    this.wake()
  }

  /** Every pool waiting for room checks again. */
  wake(): void {
    for (const wake of [...this.#waiters]) wake()
  }

  /** Calls `wake` on the next `wake`; returns how to stop waiting. */
  onRoom(wake: () => void): () => void {
    const once = () => {
      this.#waiters.delete(once)
      wake()
    }
    this.#waiters.add(once)
    return () => this.#waiters.delete(once)
  }

  /**
   * Removes the machine idle longest in a pool other than `member`, so `member` can start one
   * once it has gone. False when no other pool has an idle machine.
   */
  evictFor(member: AccountMember): boolean {
    let idlest: { since: number; evict(): void } | null = null
    for (const other of this.#members) {
      if (other === member) continue
      const idle = other.idlest()
      if (idle && (!idlest || idle.since < idlest.since)) idlest = idle
    }
    idlest?.evict()
    return idlest !== null
  }

  /** Spends one of the run's starts, failing once there's none left. */
  takeStart(): void {
    if (this.#startsLeft === null) return
    if (this.#startsLeft <= 0) {
      throw new InfraError(
        `${this.helper} has used every machine start the run has (${this.limits.starts})`,
      )
    }
    this.#startsLeft--
  }

  /** A start the provider refused started nothing, so the run keeps it. */
  giveStart(): void {
    if (this.#startsLeft !== null) this.#startsLeft++
  }

  nextBackoff(): number {
    const wait = this.#backoffMs
    this.#backoffMs = Math.min(this.#backoffMs * 2, this.#backoff.max)
    return wait
  }

  resetBackoff(): void {
    this.#backoffMs = this.#backoff.first
  }

  /** No start on the account goes out for `ms`: the provider is limiting it, not one start. */
  hold(ms: number): void {
    const until = Date.now() + ms
    if (until <= this.#heldUntil) return
    this.#heldUntil = until
    for (const queue of this.#queues) queue.pause()
    clearTimeout(this.#held)
    this.#held = setTimeout(() => {
      for (const queue of this.#queues) queue.start()
    }, ms)
  }

  /**
   * Runs `fn` once every window has room, hour then minute, or fails once it has waited
   * `withinMs`. Only the wait is bounded: a start under way is never cut short, or its machine
   * would be left running.
   */
  gate<T>(
    fn: () => Promise<T>,
    withinMs: number,
    stop: AbortSignal,
    onQueued: (ms: number) => void,
  ): Promise<T> {
    const queued = performance.now()
    const waiting = new AbortController()
    const stopped = () => waiting.abort(stop.reason)
    stop.addEventListener('abort', stopped, { once: true })
    const { startsPerHour, startsPerMinute } = this.limits
    const caps = [
      startsPerHour != null && `${startsPerHour} an hour`,
      startsPerMinute != null && `${startsPerMinute} a minute`,
    ].filter(Boolean)
    const timer = setTimeout(
      () =>
        waiting.abort(
          new InfraError(
            `${this.helper} had no room to start a machine for ${Math.round((performance.now() - queued) / 1000)}s${caps.length ? `: the account's starts are capped at ${caps.join(' and ')}, counting the ones it made before this run` : ''}`,
          ),
        ),
      Math.max(0, withinMs),
    )
    const run = () => {
      clearTimeout(timer)
      stop.removeEventListener('abort', stopped)
      onQueued(performance.now() - queued)
      return fn()
    }
    return this.#queues
      .reduceRight<() => Promise<T>>(
        (inner, queue) => () => queue.add(inner, { signal: waiting.signal }) as Promise<T>,
        run,
      )()
      .finally(() => {
        clearTimeout(timer)
        stop.removeEventListener('abort', stopped)
      })
  }

  /** Drops the starts still waiting for a window, and the hold's timer. */
  close(): void {
    clearTimeout(this.#held)
    for (const queue of this.#queues) queue.clear()
  }
}
