// The run's machine pools, as the `machines` service: the main process holds one pool per
// provider account and size, so every eval file's worker shares its start rate and its machines,
// and closes them all when the run ends. A worker leases a slot over its IPC channel (or, outside
// a worker, from pools in its own process) and gives it back when its attempt is done.
import { callService } from '../scheduler/services.ts'
import type { MachineDescriptor } from './machine.ts'
import { MACHINE_PROVIDERS } from './machines.ts'
import { type LeaseFacts, MachinePool, type PoolLease } from './pool.ts'

export const MACHINES = 'machines'

/** What a worker asks the `machines` service. */
export type MachineCall =
  | {
      op: 'lease'
      /** Names the request, so the worker can abandon it while it waits. */
      ticket: string
      sandbox: MachineDescriptor
      runId: string
      /** The project, where the provider's SDK resolves from. */
      root: string
      /** How long the attempt may hold the machine. */
      ttlSeconds: number
    }
  | { op: 'release'; ticket: string; broken: boolean }
  /** The worker stopped waiting (its attempt was canceled): a lease granted since goes back. */
  | { op: 'abandon'; ticket: string }

/** A granted lease, as it crosses the channel. */
export type WireLease = LeaseFacts & { info: unknown }

type Held = { owner: string; lease?: PoolLease<unknown>; waiting?: AbortController }

/** How a sandbox kind pools its machines: one pool per `key`, opened with `open`. */
export type Pooled = { key(s: MachineDescriptor): string; open: OpenPool<MachineDescriptor> }

const registered = (sandbox: MachineDescriptor) =>
  MACHINE_PROVIDERS.find((m) => m.kind === sandbox.kind)?.pool as Pooled | undefined

/** The run's pools, keyed by provider account and size. */
export class MachineService {
  readonly #pools = new Map<string, Promise<MachinePool<unknown>>>()
  readonly #held = new Map<string, Held>()
  readonly #idleMs: number | undefined
  readonly #pooled: (sandbox: MachineDescriptor) => Pooled | undefined
  #closed = false

  constructor(
    o: { idleMs?: number; pooled?: (sandbox: MachineDescriptor) => Pooled | undefined } = {},
  ) {
    this.#idleMs = o.idleMs
    this.#pooled = o.pooled ?? registered
  }

  async call(owner: string, body: unknown): Promise<unknown> {
    const call = body as MachineCall
    const key = `${owner}:${call.ticket}`
    if (call.op === 'release' || call.op === 'abandon') {
      const held = this.#held.get(key)
      this.#held.delete(key)
      held?.waiting?.abort(new Error('The attempt stopped waiting for a machine'))
      held?.lease?.release(call.op === 'release' && call.broken)
      return null
    }
    if (this.#closed) throw new Error("The run's machine pools are closed")
    const waiting = new AbortController()
    this.#held.set(key, { owner, waiting })
    let lease: PoolLease<unknown>
    try {
      const pool = await this.#pool(call)
      waiting.signal.throwIfAborted()
      lease = await pool.acquire({ signal: waiting.signal, ttlSeconds: call.ttlSeconds })
    } catch (error) {
      this.#held.delete(key)
      throw error
    }
    if (!this.#held.has(key)) {
      lease.release()
      throw new Error('The attempt stopped waiting for a machine')
    }
    this.#held.set(key, { owner, lease })
    const { info, machine, slot, reused, start } = lease
    return { info, machine, slot, reused, start } satisfies WireLease
  }

  /** `owner`'s worker is gone: what it waited for is abandoned, what it held is broken. */
  released(owner: string): void {
    for (const [key, held] of this.#held) {
      if (held.owner !== owner) continue
      this.#held.delete(key)
      held.waiting?.abort(new Error("The attempt's worker exited"))
      held.lease?.release(true)
    }
  }

  /** What each pool did, by its key. */
  async stats() {
    return Object.fromEntries(
      await Promise.all(
        [...this.#pools].map(async ([key, pool]) => [
          key,
          await pool.then((p) => p.stats()).catch(() => null),
        ]),
      ),
    )
  }

  /** Removes every machine of every pool. */
  async close(): Promise<void> {
    this.#closed = true
    await Promise.all(
      [...this.#pools.values()].map((p) => p.then((pool) => pool.close()).catch(() => {})),
    )
  }

  #pool(call: Extract<MachineCall, { op: 'lease' }>): Promise<MachinePool<unknown>> {
    const pooled = this.#pooled(call.sandbox)
    if (!pooled) throw new Error(`${call.sandbox.kind} sandboxes have no machine pool`)
    const key = `${call.runId}\0${pooled.key(call.sandbox)}`
    let pool = this.#pools.get(key)
    if (!pool) {
      pool = pooled.open(call.sandbox, { runId: call.runId, root: call.root }).then(
        ({ provider, options }) =>
          new MachinePool(provider, {
            ...options,
            ...(this.#idleMs !== undefined && { idleMs: this.#idleMs }),
          }),
      )
      pool.catch(() => this.#pools.delete(key))
      this.#pools.set(key, pool)
    }
    return pool
  }
}

/** How a provider opens its pool for one account and size. */
export type OpenPool<D extends MachineDescriptor> = (
  sandbox: D,
  o: { runId: string; root: string },
) => Promise<{
  provider: import('./pool.ts').PoolProvider<unknown>
  options: import('./pool.ts').PoolOptions
}>

/** Outside a worker: pools in this process, gone a second after they're idle. */
let local: MachineService | undefined
const localCall = (body: unknown) => {
  local ??= new MachineService({ idleMs: 1_000 })
  return local.call('local', body)
}

let tickets = 0

/** A slot on one of the run's pooled machines, leased for one attempt. */
export type MachineLease = WireLease & {
  /** Gives the slot back; `broken` takes its machine out of the pool. */
  release(broken?: boolean): Promise<void>
}

/** Leases a slot on a machine of `sandbox`'s pool, waiting while none is free. */
export async function leaseMachine(
  request: Omit<Extract<MachineCall, { op: 'lease' }>, 'op' | 'ticket'>,
  signal: AbortSignal,
): Promise<MachineLease> {
  signal.throwIfAborted()
  const ticket = `${process.pid}-${++tickets}`
  const send = (body: MachineCall) => callService(MACHINES, body, localCall)
  const leased = send({ op: 'lease', ticket, ...request }) as Promise<WireLease>
  const stop = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  stop.catch(() => {})
  try {
    const lease = await Promise.race([leased, stop])
    return {
      ...lease,
      release: async (broken = false) => {
        await send({ op: 'release', ticket, broken }).catch(() => {})
      },
    }
  } catch (error) {
    if (signal.aborted) {
      leased.catch(() => {})
      await send({ op: 'abandon', ticket }).catch(() => {})
    }
    throw error
  }
}
