// Grants leases on named resources, each with a limit. The main process runs one of these for
// the whole run, so limits hold across Vitest workers; see ./server.ts and ./client.ts.

/** Where an attempt sits in the run, for ordering. Requests without one are served first come. */
export type Rank = {
  /** The eval's id. Attempts of the same eval and run number start together. */
  eval: string
  file: string
  /** Registration order within the file. */
  order: number
  /** Run number. */
  n: number
  /** The cell's position in the eval's matrix. */
  cell: number
}

/** Resource name → the most leases on it this request allows while it holds one. */
export type Limits = Record<string, number>

export type Request = {
  id: string
  /** The connection (worker) that asked; its leases go when it does. */
  owner: string
  limits: Limits
  rank?: Rank
}

type Waiting = Request & { seq: number }

const runKey = (r: Rank) => `${r.eval}\0${r.n}`

/**
 * Leases are granted when every named resource has room under the request's own limit, so a
 * request that asks for `docker: 2` waits while two Docker leases are out, whatever other
 * requests allow. Among attempts that could start, the order is:
 *
 * 1. the rest of a run already started (the other cells of the same eval and run number), so a
 *    control and its variants run close together;
 * 2. the eval with the fewest runs started, so every eval gets a first result early;
 * 3. lower run number, then file, registration order and cell.
 */
export class Scheduler {
  readonly #waiting: Waiting[] = []
  readonly #held = new Map<string, Request>()
  readonly #inUse = new Map<string, number>()
  readonly #runsStarted = new Map<string, Set<string>>()
  readonly #onGrant: (request: Request) => void
  #seq = 0
  #paused = false

  constructor(onGrant: (request: Request) => void) {
    this.#onGrant = onGrant
  }

  get held(): number {
    return this.#held.size
  }

  get waiting(): number {
    return this.#waiting.length
  }

  inUse(resource: string): number {
    return this.#inUse.get(resource) ?? 0
  }

  request(request: Request): void {
    this.#waiting.push({ ...request, seq: this.#seq++ })
    this.#pump()
  }

  /** Drops a request that's still waiting, or releases its lease. */
  release(id: string): void {
    const index = this.#waiting.findIndex((w) => w.id === id)
    if (index >= 0) this.#waiting.splice(index, 1)
    const held = this.#held.get(id)
    if (held) {
      this.#held.delete(id)
      for (const name of Object.keys(held.limits)) {
        this.#inUse.set(name, (this.#inUse.get(name) ?? 1) - 1)
      }
    }
    this.#pump()
  }

  /** Everything a connection asked for or held, e.g. when its worker exits. */
  releaseOwner(owner: string): void {
    const ids = [
      ...this.#waiting.filter((w) => w.owner === owner).map((w) => w.id),
      ...[...this.#held.values()].filter((h) => h.owner === owner).map((h) => h.id),
    ]
    for (const id of ids) this.release(id)
  }

  /** While paused, requests queue up but nothing is granted. */
  pause(): void {
    this.#paused = true
  }

  resume(): void {
    this.#paused = false
    this.#pump()
  }

  #fits(r: Request): boolean {
    return Object.entries(r.limits).every(([name, limit]) => (this.#inUse.get(name) ?? 0) < limit)
  }

  #compare = (a: Waiting, b: Waiting): number => {
    if (!a.rank || !b.rank) return a.rank ? 1 : b.rank ? -1 : a.seq - b.seq
    const ra = a.rank
    const rb = b.rank
    const started = (r: Rank) => (this.#runsStarted.get(r.eval)?.has(runKey(r)) ? 0 : 1)
    const runs = (r: Rank) => this.#runsStarted.get(r.eval)?.size ?? 0
    return (
      started(ra) - started(rb) ||
      runs(ra) - runs(rb) ||
      ra.n - rb.n ||
      (ra.file < rb.file ? -1 : ra.file > rb.file ? 1 : 0) ||
      ra.order - rb.order ||
      ra.cell - rb.cell ||
      a.seq - b.seq
    )
  }

  #pump(): void {
    if (this.#paused) return
    for (;;) {
      const next = this.#waiting.filter((w) => this.#fits(w)).sort(this.#compare)[0]
      if (!next) return
      this.#waiting.splice(this.#waiting.indexOf(next), 1)
      const { seq: _, ...request } = next
      this.#held.set(request.id, request)
      for (const name of Object.keys(request.limits)) {
        this.#inUse.set(name, (this.#inUse.get(name) ?? 0) + 1)
      }
      if (request.rank) {
        const runs = this.#runsStarted.get(request.rank.eval) ?? new Set()
        runs.add(runKey(request.rank))
        this.#runsStarted.set(request.rank.eval, runs)
      }
      this.#onGrant(request)
    }
  }
}
