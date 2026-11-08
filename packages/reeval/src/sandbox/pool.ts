// A pool of remote machines for one machine size and image of a provider account, in the run's
// main process, under the scheduler: an attempt asks for a slot only once its lease is granted.
// tarn pools the slots, the account (`pool-account.ts`) holds starts to the provider's rate and
// counts the machines of every pool on it, and p-retry waits out a rate-limited start. What a
// provider gives it is how to start and remove a machine, how to keep one alive, its limits, and
// how to tell a rate limit from a real failure.
import pRetry from 'p-retry'
import tarn, { type Pool } from 'tarn'
import {
  type AccountMember,
  PoolAccount,
  type PoolLimits,
  RATE_LIMIT_WAITS,
} from './pool-account.ts'
import { InfraError } from './types.ts'

export { RATE_LIMIT_WAITS }

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
  /**
   * Restarts the clock of a machine about to run another attempt: it now expires `ttlSeconds`
   * from this call, not from its start. A machine that can't be kept alive is taken out of the
   * pool, so the attempt gets another.
   */
  keepAlive?(id: string, ttlSeconds: number): Promise<void>
  /** Whether `error`, from `start`, is the provider refusing for now rather than failing. */
  rateLimited(error: unknown): RateLimited | null
}

export type PoolOptions = {
  /** The account's limits, which a pool opened with an `account` takes from it instead. */
  limits: PoolLimits
  /**
   * The account this pool shares with the run's other pools on it, whose limits, backoff and
   * windows hold instead of this pool's; else one of its own.
   */
  account?: PoolAccount
  /** The most machines this pool holds at once, within the account's. Default the account's. */
  machines?: number
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
  /**
   * The machine's start, for its first lease: how long it took, how long of that it waited for
   * room in the start windows, and the rate limits it waited out.
   */
  start: MachineStart | null
  /** The machines dropped for this lease because keeping them alive failed, and why. */
  lost: { machine: string; error: string }[]
}

export type MachineStart = { ms: number; queuedMs: number; rateLimited: number }

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
  /** Machines dropped because keeping them alive for another attempt failed. */
  keepAliveFailed: number
  /** Idle machines removed so another pool on the account could start one. */
  evicted: number
}

type Machine<M> = {
  id?: string
  info?: M
  ready: Promise<void>
  unclaimed: number[]
  alive: number
  draining: boolean
  removed?: Promise<void>
  start: MachineStart | null
  /**
   * No attempt waits for it any more: a start still queued never goes out, and one under way is
   * removed once up.
   */
  stop: AbortController
  /** Slots out of tarn: leased, or being kept alive for a lease. */
  busy: number
  /** When `busy` last went to 0. */
  idleSince: number
  /** It's being removed so another pool on the account can start one. */
  evicted: boolean
}

type Slot<M> = {
  machine: Machine<M>
  slot: number
  uses: number
  dead: boolean
  /** Counted in its machine's `busy`. */
  out: boolean
}

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
  readonly #options: Required<Omit<PoolOptions, 'limits' | 'account' | 'machines'>>
  readonly #account: PoolAccount
  readonly #ownAccount: boolean
  readonly #member: AccountMember
  /** The most machines this pool holds at once. */
  readonly #cap: number
  readonly #machines = new Set<Machine<M>>()
  readonly #leased = new Set<Slot<M>>()
  readonly #slots: Pool<Slot<M>>
  readonly #closing = new AbortController()
  readonly #stopReason: InfraError
  #reaping: NodeJS.Timeout | undefined
  #ttlSeconds = 0
  #closed: Promise<void> | undefined
  readonly #stats: PoolStats = {
    starts: 0,
    rateLimited: 0,
    machinesAtOnce: 0,
    leases: 0,
    reusedLeases: 0,
    keepAliveFailed: 0,
    evicted: 0,
  }

  constructor(provider: PoolProvider<M>, options: PoolOptions) {
    this.#provider = provider
    this.#stopReason = new InfraError(`${provider.helper}: no attempt waits for this machine`)
    const { limits, account, machines, ...rest } = options
    this.#options = {
      idleMs: 15_000,
      ...RATE_LIMIT_WAITS,
      windowsMs: { minute: 60_000, hour: 3_600_000 },
      ...rest,
      attemptsPerMachine: Math.max(1, Math.floor(options.attemptsPerMachine)),
    }
    this.#ownAccount = !account
    this.#account = account ?? new PoolAccount(provider.helper, { ...this.#options, limits })
    this.#cap = Math.max(
      1,
      Math.min(machines ?? Number.POSITIVE_INFINITY, this.#account.limits.machines),
    )
    this.#member = { idlest: () => this.#idlest() }
    this.#account.join(this.#member)
    const { idleMs, attemptsPerMachine } = this.#options
    this.#slots = new tarn.Pool<Slot<M>>({
      min: 0,
      max: this.#cap * attemptsPerMachine,
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
    const lost: LeaseFacts['lost'] = []
    for (;;) {
      const slot = await this.#take(signal)
      const { machine } = slot
      if (machine.draining) {
        this.#slots.release(slot)
        continue
      }
      machine.busy++
      slot.out = true
      const first = machine.start
      machine.start = null
      if (!first && this.#provider.keepAlive) {
        try {
          await this.#provider.keepAlive(machine.id as string, this.#ttlSeconds)
        } catch (error) {
          this.#stats.keepAliveFailed++
          lost.push({
            machine: machine.id as string,
            error: (error as Error)?.message ?? String(error),
          })
          this.#release(slot, true)
          signal?.throwIfAborted()
          continue
        }
      }
      const reused = slot.uses++
      this.#leased.add(slot)
      this.#stats.leases++
      if (reused) this.#stats.reusedLeases++
      let released = false
      return {
        machine: machine.id as string,
        slot: slot.slot,
        reused,
        start: first,
        lost,
        info: machine.info as M,
        release: (broken = false) => {
          if (released) return
          released = true
          this.#release(slot, broken)
        },
      }
    }
  }

  async #take(signal: AbortSignal | undefined): Promise<Slot<M>> {
    if (this.#closed) throw new InfraError(`${this.#provider.helper}'s machine pool is closed`)
    signal?.throwIfAborted()
    const pending = this.#slots.acquire()
    const abort = () => pending.abort()
    signal?.addEventListener('abort', abort, { once: true })
    try {
      return await pending.promise
    } catch (error) {
      if (signal?.aborted) {
        this.#stopUnwanted()
        this.#reapUntaken()
        throw signal.reason
      }
      if (this.#closed) throw this.#closing.signal.reason
      throw error
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  }

  stats(): PoolStats {
    return { ...this.#stats }
  }

  /** Removes every machine, those in use and starting included; waiting attempts fail. */
  close(): Promise<void> {
    this.#closed ??= (async () => {
      this.#closing.abort(new InfraError(`${this.#provider.helper}'s machine pool closed`))
      clearInterval(this.#reaping)
      this.#account.leave(this.#member)
      if (this.#ownAccount) this.#account.close()
      for (const slot of [...this.#leased]) this.#release(slot, true)
      await this.#slots.destroy().catch(() => {})
      await Promise.all([...this.#machines].map((m) => this.#remove(m)))
    })()
    return this.#closed
  }

  /**
   * tarn reaps idle slots only once an acquire has succeeded, so a machine started for an acquire
   * that was aborted would sit free for good: check for idle ones until none is free or starting.
   */
  #reapUntaken() {
    this.#reaping ??= setInterval(
      () => {
        this.#slots.check()
        if (this.#slots.numFree() + this.#slots.numPendingCreates() > 0) return
        clearInterval(this.#reaping)
        this.#reaping = undefined
      },
      Math.min(1_000, this.#options.idleMs),
    )
  }

  /** With no attempt left waiting, the machines still starting would only sit idle: stop them. */
  #stopUnwanted() {
    if (this.#slots.numPendingAcquires() > 0) return
    for (const machine of this.#machines) {
      if (machine.id === undefined && !machine.draining) {
        machine.stop.abort(this.#stopReason)
      }
    }
  }

  #release(slot: Slot<M>, broken: boolean) {
    this.#leased.delete(slot)
    const { machine } = slot
    if (slot.out) {
      slot.out = false
      if (--machine.busy === 0) {
        machine.idleSince = performance.now()
        // Kept, tarn would hand it to this pool's next attempt before a pool already waiting.
        if (
          !broken &&
          !machine.draining &&
          !this.#closing.signal.aborted &&
          this.#account.wanted(this.#member)
        ) {
          this.#account.evicting()
          this.#evict(machine)
        }
      }
    }
    if (broken) machine.draining = true
    if (broken || !this.#options.reuse) this.#kill(slot)
    this.#slots.release(slot)
  }

  /**
   * tarn's `create`: a slot on a machine that's up or starting, else on a new machine once the
   * provider has room for one. tarn counts slots, and a machine being removed, or one whose other
   * slots still run, holds its place at the provider until it's gone.
   */
  async #claim(): Promise<Slot<M>> {
    for (;;) {
      try {
        return await this.#claimOnce()
      } catch (error) {
        // A start stopped for want of an attempt, with one waiting again: it gets another.
        const stopped = error === this.#stopReason && !this.#closing.signal.aborted
        if (!stopped || this.#slots.numPendingAcquires() === 0) throw error
      }
    }
  }

  async #claimOnce(): Promise<Slot<M>> {
    const open = () => [...this.#machines].find((m) => !m.draining && m.unclaimed.length)
    let machine = open()
    while (!machine) {
      const own = this.#machines.size < this.#cap
      if (own && this.#account.reserve()) {
        machine = this.#startMachine()
        break
      }
      const room = this.#room(own)
      if (own) this.#account.evictFor(this.#member)
      await room
      machine = open()
    }
    const slot: Slot<M> = {
      machine,
      slot: machine.unclaimed.shift() as number,
      uses: 0,
      dead: false,
      out: false,
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
      this.#forget(machine)
    })()
    return machine.removed
  }

  #forget(machine: Machine<M>) {
    if (this.#machines.delete(machine)) this.#account.free(machine.evicted)
  }

  /**
   * Resolves once a machine on the account has gone; rejects when the pool closes. `evicts`: the
   * pool is under its own cap, so another pool's machine going would let it start one.
   */
  #room(evicts: boolean): Promise<void> {
    const closing = this.#closing.signal
    closing.throwIfAborted()
    return new Promise((resolve, reject) => {
      const unwait = this.#account.wait(this.#member, evicts, () => {
        closing.removeEventListener('abort', stop)
        resolve()
      })
      const stop = () => {
        unwait()
        reject(closing.reason)
      }
      closing.addEventListener('abort', stop, { once: true })
    })
  }

  /**
   * The machine idle longest, for the account to remove for another pool. A machine no attempt has
   * leased yet is on its way to one, or is reaped once no attempt wants it.
   */
  #idlest(): { since: number; evict(): void } | null {
    let idlest: Machine<M> | undefined
    for (const m of this.#machines) {
      if (m.id === undefined || m.start !== null || m.draining || m.busy > 0) continue
      if (!idlest || m.idleSince < idlest.idleSince) idlest = m
    }
    if (!idlest) return null
    const machine = idlest
    return { since: machine.idleSince, evict: () => this.#evict(machine) }
  }

  #evict(machine: Machine<M>) {
    this.#stats.evicted++
    machine.evicted = true
    machine.draining = true
    machine.unclaimed = []
    void this.#remove(machine)
  }

  #startMachine(): Machine<M> {
    const k = this.#options.attemptsPerMachine
    const machine: Machine<M> = {
      ready: Promise.resolve(),
      unclaimed: Array.from({ length: k }, (_, i) => i),
      alive: 0,
      draining: false,
      start: null,
      stop: new AbortController(),
      busy: 0,
      idleSince: 0,
      evicted: false,
    }
    this.#machines.add(machine)
    this.#stats.machinesAtOnce = Math.max(this.#stats.machinesAtOnce, this.#machines.size)
    const started = performance.now()
    let rateLimited = 0
    let queuedMs = 0
    machine.ready = this.#started(
      AbortSignal.any([this.#closing.signal, machine.stop.signal]),
      () => rateLimited++,
      (ms) => {
        queuedMs += ms
      },
    ).then(
      ({ id, info }) => {
        machine.id = id
        machine.info = info
        machine.start = {
          ms: Math.round(performance.now() - started),
          queuedMs: Math.round(queuedMs),
          rateLimited,
        }
        this.#account.resetBackoff()
      },
      (error: unknown) => {
        machine.draining = true
        machine.unclaimed = []
        this.#forget(machine)
        throw error
      },
    )
    machine.ready.catch(() => {})
    return machine
  }

  /** One start, through the rate gate, again after each rate limit until `maxRateWaitMs`. */
  #started(
    signal: AbortSignal,
    onRateLimit: () => void,
    onQueued: (ms: number) => void,
  ): Promise<{ id: string; info: M }> {
    const provider = this.#provider
    const startedAt = performance.now()
    return pRetry(
      () =>
        this.#account.gate(
          async () => {
            signal.throwIfAborted()
            this.#account.takeStart()
            this.#stats.starts++
            // Only the pool's close cuts a start short: a machine stopped mid-provision can come up
            // anyway (Boat drops a delete sent then), and only a canceled run reaps by name.
            const started = await provider.start(this.#closing.signal, this.#ttlSeconds)
            // Stopped as it booted: nothing would hold the machine, so it goes now.
            if (signal.aborted) {
              await provider.remove(started.id).catch(() => {})
              throw signal.reason
            }
            return started
          },
          this.#options.maxRateWaitMs - (performance.now() - startedAt),
          signal,
          onQueued,
        ),
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
          this.#account.giveStart()
          this.#stats.rateLimited++
          onRateLimit()
          const wait = limited.retryAfterMs ?? this.#account.nextBackoff()
          if (performance.now() - startedAt + wait > this.#options.maxRateWaitMs) {
            throw new InfraError(
              `${provider.helper} kept refusing to start a machine for ${Math.round((performance.now() - startedAt) / 1000)}s, asking to wait ${Math.round(wait / 1000)}s more: ${error.message}`,
            )
          }
          this.#account.hold(wait)
          await sleep(wait, signal)
        },
      },
    )
  }
}
