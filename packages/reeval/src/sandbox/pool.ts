// A pool of remote machines for one provider account, in the run's main process, under the
// scheduler: an attempt asks for a slot only once its lease is granted. tarn pools the slots,
// p-queue holds starts to the provider's rate and p-retry waits out a rate-limited start. What a
// provider gives it is how to start and remove a machine, how to keep one alive, its limits, and
// how to tell a rate limit from a real failure.
import PQueue from 'p-queue'
import pRetry from 'p-retry'
import tarn, { type Pool } from 'tarn'
import { InfraError } from './types.ts'

/** How many machines and starts the provider allows the pool. */
export type PoolLimits = {
  /** The most machines at once. */
  machines: number
  /** Starts in any 60 s, when the provider caps them. */
  startsPerMinute?: number | null
  /** Starts in any hour, counting the ones the account made before this run. */
  startsPerHour?: number | null
}

/** A rate-limited start, and how long the provider asked to wait (null: it didn't say). */
export type RateLimited = { retryAfterMs: number | null }

/** One machine provider account, as the pool sees it. `M` is how a worker reaches a machine. */
export type PoolProvider<M> = {
  /** How messages name the provider: `boat()`. */
  helper: string
  /**
   * Starts one machine that expires by itself after `ttlSeconds`, and returns it once it's
   * reachable; removes what it made when it fails.
   */
  start(signal: AbortSignal, ttlSeconds: number): Promise<{ id: string; info: M }>
  /** Removes a machine; one already gone is removed. */
  remove(id: string): Promise<void>
  /** Keeps a machine about to run another attempt from expiring for `ttlSeconds` more. */
  keepAlive?(id: string, ttlSeconds: number): Promise<void>
  /** Whether `error`, from `start`, is the provider refusing for now rather than failing. */
  rateLimited(error: unknown): RateLimited | null
}

export type PoolOptions = {
  limits: PoolLimits
  /** Attempts one machine runs at once, each in a slot of its own. */
  attemptsPerMachine: number
  /** A slot takes another attempt after its first, reset; else each slot runs one. */
  reuse: boolean
  /** How long a free slot waits for another attempt before it goes. Default 15 s. */
  idleMs?: number
  /** How long starts may keep being rate-limited before the waiting attempts fail. Default 15 min. */
  maxRateWaitMs?: number
  /** The first wait after a rate limit that named none, doubling to `maxBackoffMs`. Default 5 s. */
  backoffMs?: number
  /** Default 60 s. */
  maxBackoffMs?: number
  /** The windows `startsPerMinute` and `startsPerHour` count in. Default a minute and an hour. */
  windowsMs?: { minute: number; hour: number }
}

/** What a lease says about its machine, for the attempt's debug trace. */
export type LeaseFacts = {
  machine: string
  slot: number
  /** The attempts this slot ran before this one. */
  reused: number
  /** The machine's start, for its first lease: how long it took and the rate limits it waited out. */
  start: { ms: number; rateLimited: number } | null
}

export type PoolLease<M> = LeaseFacts & {
  info: M
  /** Gives the slot back; `broken` takes its machine out of the pool. */
  release(broken?: boolean): void
}

/** What the pool did, for the run's debug trace and measurements. */
export type PoolStats = {
  starts: number
  rateLimited: number
  machinesAtOnce: number
  leases: number
  reusedLeases: number
}

type Machine<M> = {
  id?: string
  info?: M
  ready: Promise<void>
  unclaimed: number[]
  alive: number
  draining: boolean
  removed?: Promise<void>
  start: { ms: number; rateLimited: number } | null
}

type Slot<M> = { machine: Machine<M>; slot: number; uses: number; dead: boolean }

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })

/** tarn's timers are setTimeout's, which can't hold more than this. */
const FOREVER_MS = 2 ** 31 - 1

export class MachinePool<M> {
  readonly #provider: PoolProvider<M>
  readonly #options: Required<Omit<PoolOptions, 'limits'>> & { limits: PoolLimits }
  readonly #machines = new Set<Machine<M>>()
  readonly #leased = new Set<Slot<M>>()
  readonly #slots: Pool<Slot<M>>
  readonly #queues: PQueue[] = []
  readonly #closing = new AbortController()
  #heldUntil = 0
  #held: NodeJS.Timeout | undefined
  #backoffMs: number
  #ttlSeconds = 0
  #closed: Promise<void> | undefined
  readonly #stats: PoolStats = {
    starts: 0,
    rateLimited: 0,
    machinesAtOnce: 0,
    leases: 0,
    reusedLeases: 0,
  }

  constructor(provider: PoolProvider<M>, options: PoolOptions) {
    this.#provider = provider
    this.#options = {
      idleMs: 15_000,
      maxRateWaitMs: 15 * 60_000,
      backoffMs: 5_000,
      maxBackoffMs: 60_000,
      windowsMs: { minute: 60_000, hour: 3_600_000 },
      ...options,
      attemptsPerMachine: Math.max(1, Math.floor(options.attemptsPerMachine)),
    }
    this.#backoffMs = this.#options.backoffMs
    const { startsPerMinute, startsPerHour } = options.limits
    const { windowsMs } = this.#options
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
    const { idleMs, attemptsPerMachine } = this.#options
    this.#slots = new tarn.Pool<Slot<M>>({
      min: 0,
      max: Math.max(1, options.limits.machines) * attemptsPerMachine,
      propagateCreateError: true,
      acquireTimeoutMillis: FOREVER_MS,
      createTimeoutMillis: FOREVER_MS,
      destroyTimeoutMillis: 60_000,
      idleTimeoutMillis: idleMs,
      reapIntervalMillis: Math.min(1_000, idleMs),
      create: () => this.#claim(),
      destroy: (slot) => this.#retire(slot),
      validate: (slot) =>
        !slot.dead && !slot.machine.draining && (this.#options.reuse || !slot.uses),
    })
  }

  /**
   * Waits for a slot, starting a machine for it when none is free. `ttlSeconds` is how long the
   * attempt may hold it; every machine lives at least as long as the longest any attempt asked.
   */
  async acquire(o: { signal?: AbortSignal; ttlSeconds?: number } = {}): Promise<PoolLease<M>> {
    const { signal } = o
    this.#ttlSeconds = Math.max(this.#ttlSeconds, o.ttlSeconds ?? 0)
    if (this.#closed) throw new InfraError(`${this.#provider.helper}'s machine pool is closed`)
    signal?.throwIfAborted()
    const pending = this.#slots.acquire()
    const abort = () => pending.abort()
    signal?.addEventListener('abort', abort, { once: true })
    let slot: Slot<M>
    try {
      slot = await pending.promise
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      if (this.#closed) throw this.#closing.signal.reason
      throw error
    } finally {
      signal?.removeEventListener('abort', abort)
    }
    const { machine } = slot
    const reused = slot.uses++
    this.#leased.add(slot)
    this.#stats.leases++
    if (reused) this.#stats.reusedLeases++
    const first = machine.start
    machine.start = null
    if (!first) {
      await this.#provider.keepAlive?.(machine.id as string, this.#ttlSeconds).catch(() => {})
    }
    let released = false
    return {
      machine: machine.id as string,
      slot: slot.slot,
      reused,
      start: first,
      info: machine.info as M,
      release: (broken = false) => {
        if (released) return
        released = true
        this.#release(slot, broken)
      },
    }
  }

  stats(): PoolStats {
    return { ...this.#stats }
  }

  /** Removes every machine, those in use and starting included; waiting attempts fail. */
  close(): Promise<void> {
    this.#closed ??= (async () => {
      this.#closing.abort(new InfraError(`${this.#provider.helper}'s machine pool closed`))
      clearTimeout(this.#held)
      for (const queue of this.#queues) queue.clear()
      for (const slot of [...this.#leased]) this.#release(slot, true)
      await this.#slots.destroy().catch(() => {})
      await Promise.all([...this.#machines].map((m) => this.#remove(m)))
    })()
    return this.#closed
  }

  #release(slot: Slot<M>, broken: boolean) {
    this.#leased.delete(slot)
    if (broken) slot.machine.draining = true
    if (broken || !this.#options.reuse) this.#kill(slot)
    this.#slots.release(slot)
  }

  /** tarn's `create`: a slot on a machine that's up or starting, else on a new machine. */
  async #claim(): Promise<Slot<M>> {
    let machine = [...this.#machines].find((m) => !m.draining && m.unclaimed.length)
    if (!machine) machine = this.#startMachine()
    const slot: Slot<M> = {
      machine,
      slot: machine.unclaimed.shift() as number,
      uses: 0,
      dead: false,
    }
    machine.alive++
    try {
      await machine.ready
    } catch (error) {
      this.#kill(slot)
      throw error
    }
    return slot
  }

  /** tarn's `destroy`: an idle, broken or used-up slot. */
  async #retire(slot: Slot<M>) {
    this.#kill(slot)
    await slot.machine.removed
  }

  /** The slot is done; a machine with none left goes. */
  #kill(slot: Slot<M>) {
    if (slot.dead) return
    slot.dead = true
    const { machine } = slot
    if (--machine.alive > 0) return
    machine.draining = true
    void this.#remove(machine)
  }

  #remove(machine: Machine<M>): Promise<void> {
    machine.removed ??= (async () => {
      await machine.ready.catch(() => {})
      if (machine.id) await this.#provider.remove(machine.id).catch(() => {})
      this.#machines.delete(machine)
    })()
    return machine.removed
  }

  #startMachine(): Machine<M> {
    const k = this.#options.attemptsPerMachine
    const machine: Machine<M> = {
      ready: Promise.resolve(),
      unclaimed: Array.from({ length: k }, (_, i) => i),
      alive: 0,
      draining: false,
      start: null,
    }
    this.#machines.add(machine)
    this.#stats.machinesAtOnce = Math.max(this.#stats.machinesAtOnce, this.#machines.size)
    const started = performance.now()
    let rateLimited = 0
    machine.ready = this.#started(() => rateLimited++).then(
      ({ id, info }) => {
        machine.id = id
        machine.info = info
        machine.start = { ms: Math.round(performance.now() - started), rateLimited }
        this.#backoffMs = this.#options.backoffMs
      },
      (error: unknown) => {
        machine.draining = true
        machine.unclaimed = []
        this.#machines.delete(machine)
        throw error
      },
    )
    machine.ready.catch(() => {})
    return machine
  }

  /** One start, through the rate gate, again after each rate limit until `maxRateWaitMs`. */
  #started(onRateLimit: () => void): Promise<{ id: string; info: M }> {
    const signal = this.#closing.signal
    const provider = this.#provider
    const startedAt = performance.now()
    return pRetry(
      () =>
        this.#gate(async () => {
          signal.throwIfAborted()
          this.#stats.starts++
          return provider.start(signal, this.#ttlSeconds)
        }),
      {
        retries: Number.POSITIVE_INFINITY,
        minTimeout: 0,
        maxTimeout: 0,
        maxRetryTime: this.#options.maxRateWaitMs,
        signal,
        shouldConsumeRetry: ({ error }) => !provider.rateLimited(error),
        shouldRetry: ({ error }) => provider.rateLimited(error) !== null,
        onFailedAttempt: async ({ error }) => {
          const limited = provider.rateLimited(error)
          if (!limited) return
          this.#stats.rateLimited++
          onRateLimit()
          const wait = limited.retryAfterMs ?? this.#nextBackoff()
          if (performance.now() - startedAt + wait > this.#options.maxRateWaitMs) {
            throw new InfraError(
              `${provider.helper} kept refusing to start a machine for ${Math.round((performance.now() - startedAt) / 1000)}s, asking to wait ${Math.round(wait / 1000)}s more: ${error.message}`,
            )
          }
          this.#hold(wait)
          await sleep(wait, signal)
        },
      },
    )
  }

  #nextBackoff(): number {
    const wait = this.#backoffMs
    this.#backoffMs = Math.min(this.#backoffMs * 2, this.#options.maxBackoffMs)
    return wait
  }

  /** No start of this pool goes out for `ms`: the provider is limiting the account, not one start. */
  #hold(ms: number) {
    const until = Date.now() + ms
    if (until <= this.#heldUntil) return
    this.#heldUntil = until
    for (const queue of this.#queues) queue.pause()
    clearTimeout(this.#held)
    this.#held = setTimeout(() => {
      for (const queue of this.#queues) queue.start()
    }, ms)
  }

  /** Runs `fn` once every window has room, hour then minute. */
  #gate<T>(fn: () => Promise<T>): Promise<T> {
    return this.#queues.reduceRight<() => Promise<T>>(
      (inner, queue) => () => queue.add(inner) as Promise<T>,
      fn,
    )()
  }
}
