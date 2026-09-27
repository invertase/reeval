// Worker side of the scheduler. Without a server address (outside `es run`), leases come from
// an in-process scheduler with the same rules.
import { connect, type Socket } from 'node:net'
import { InfraError } from '../sandbox/types.ts'
import { type Limits, type Rank, Scheduler } from './core.ts'
import { type ClientMessage, lines, type SchedulerAddress, type ServerMessage } from './protocol.ts'

export type Lease = { release(): void }

type Pending = { resolve: () => void; reject: (error: unknown) => void }

interface Transport {
  request(id: string, limits: Limits, rank: Rank | undefined, pending: Pending): void
  release(id: string): void
}

class LocalTransport implements Transport {
  readonly #pending = new Map<string, Pending>()
  readonly #scheduler = new Scheduler((r) => {
    this.#pending.get(r.id)?.resolve()
    this.#pending.delete(r.id)
  })

  request(id: string, limits: Limits, rank: Rank | undefined, pending: Pending) {
    this.#pending.set(id, pending)
    this.#scheduler.request({ id, owner: 'local', limits, ...(rank ? { rank } : {}) })
  }

  release(id: string) {
    this.#pending.delete(id)
    this.#scheduler.release(id)
  }
}

class SocketTransport implements Transport {
  readonly #pending = new Map<string, Pending>()
  readonly #socket: Socket
  #closed: Error | undefined

  constructor(address: SchedulerAddress) {
    this.#socket = connect({ host: '127.0.0.1', port: address.port })
    this.#socket.setNoDelay(true)
    this.#socket.unref()
    this.#socket.on('error', (error) => this.#fail(error))
    this.#socket.on('close', () => this.#fail(new Error('the connection closed')))
    lines(this.#socket, (message: ServerMessage) => {
      if (message.t !== 'grant') return
      const pending = this.#pending.get(message.id)
      this.#pending.delete(message.id)
      pending?.resolve()
    })
    this.#send({ t: 'hello', token: address.token })
  }

  #fail(error: Error) {
    this.#closed ??= new InfraError(`Lost the ES scheduler: ${error.message}`)
    for (const pending of this.#pending.values()) pending.reject(this.#closed)
    this.#pending.clear()
  }

  #send(message: ClientMessage) {
    if (!this.#socket.destroyed) this.#socket.write(`${JSON.stringify(message)}\n`)
  }

  request(id: string, limits: Limits, rank: Rank | undefined, pending: Pending) {
    if (this.#closed) return pending.reject(this.#closed)
    this.#pending.set(id, pending)
    this.#send({ t: 'request', id, limits, ...(rank ? { rank } : {}) })
  }

  release(id: string) {
    this.#pending.delete(id)
    this.#send({ t: 'release', id })
  }
}

/** Over the worker's IPC channel to ES's own engine: requests out, grants back. */
class ChannelTransport implements Transport {
  readonly #pending = new Map<string, Pending>()
  readonly #send: (message: ClientMessage) => void

  constructor(send: (message: ClientMessage) => void) {
    this.#send = send
  }

  grant(id: string) {
    const pending = this.#pending.get(id)
    this.#pending.delete(id)
    pending?.resolve()
  }

  request(id: string, limits: Limits, rank: Rank | undefined, pending: Pending) {
    this.#pending.set(id, pending)
    this.#send({ t: 'request', id, limits, ...(rank ? { rank } : {}) })
  }

  release(id: string) {
    this.#pending.delete(id)
    this.#send({ t: 'release', id })
  }
}

let address: SchedulerAddress | undefined
let transport: Transport | undefined
let ids = 0

/** Points this process at the run's scheduler; called once per worker before any eval runs. */
export function useScheduler(at: SchedulerAddress | undefined): void {
  if (at?.port === address?.port && at?.token === address?.token) return
  address = at
  transport = undefined
}

/** Points this process at the run's scheduler over `send`; returns what delivers its grants. */
export function useSchedulerChannel(send: (message: ClientMessage) => void): (id: string) => void {
  const channel = new ChannelTransport(send)
  address = undefined
  transport = channel
  return (id) => channel.grant(id)
}

/**
 * Waits until every resource in `limits` has room, then holds a lease on each until released.
 * Rejects with the signal's reason if it aborts first.
 */
export function acquire(
  limits: Limits,
  options: { rank?: Rank; signal?: AbortSignal } = {},
): Promise<Lease> {
  const { rank, signal } = options
  if (signal?.aborted) return Promise.reject(signal.reason)
  transport ??= address ? new SocketTransport(address) : new LocalTransport()
  const via = transport
  const id = String(++ids)
  let released = false
  const lease: Lease = {
    release() {
      if (released) return
      released = true
      via.release(id)
    },
  }
  return new Promise<Lease>((resolve, reject) => {
    const onAbort = () => {
      lease.release()
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    via.request(id, limits, rank, {
      resolve: () => {
        signal?.removeEventListener('abort', onAbort)
        resolve(lease)
      },
      reject: (error) => {
        signal?.removeEventListener('abort', onAbort)
        reject(error)
      },
    })
  })
}

/** Runs `fn` while holding leases on `limits`. */
export async function withLease<T>(
  limits: Limits,
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const lease = await acquire(limits, signal ? { signal } : {})
  try {
    return await fn()
  } finally {
    lease.release()
  }
}
