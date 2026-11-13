// OpenTelemetry's batch processor, for spans and log records: items queue as they end and go out
// a batch at a time, once the batch is full or a delay after the first queued, with one request
// in flight. A failed batch is dropped, as the SDK's is; a full queue drops new items.

export type BatchOptions = {
  /** `OTEL_BSP_SCHEDULE_DELAY`: how long an item waits for its batch to fill. */
  delayMs: number
  /** `OTEL_BSP_MAX_EXPORT_BATCH_SIZE`. */
  maxBatch: number
  /** `OTEL_BSP_MAX_QUEUE_SIZE`. */
  maxQueue: number
}

/** The batch options from `OTEL_<prefix>_*` (`BSP` for spans, `BLRP` for logs), with the SDK's defaults. */
export function batchOptions(
  env: Record<string, string | undefined>,
  prefix: string,
): BatchOptions {
  const read = (name: string, fallback: number) => {
    const n = Number(env[`OTEL_${prefix}_${name}`])
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
  }
  const maxQueue = read('MAX_QUEUE_SIZE', 2048)
  return {
    delayMs: read('SCHEDULE_DELAY', prefix === 'BLRP' ? 1000 : 5000),
    maxQueue,
    maxBatch: Math.min(read('MAX_EXPORT_BATCH_SIZE', 512), maxQueue),
  }
}

export class Batcher<T> {
  readonly #send: (items: T[]) => Promise<string | null>
  readonly #o: BatchOptions
  readonly #noun: string
  #queue: T[] = []
  #timer: ReturnType<typeof setTimeout> | undefined
  #sending: Promise<void> | undefined
  #draining = false
  #closed = false
  #total = 0
  #lost = 0
  #why: string | undefined

  /** `send` posts a batch and resolves to null, or to why it wasn't taken; it never throws. */
  constructor(send: (items: T[]) => Promise<string | null>, o: BatchOptions, noun: string) {
    this.#send = send
    this.#o = o
    this.#noun = noun
  }

  add(item: T): void {
    if (this.#closed) return
    this.#total++
    if (this.#queue.length >= this.#o.maxQueue) {
      this.#lost++
      this.#why ??= `the queue of ${this.#o.maxQueue} ${this.#noun} was full`
      return
    }
    this.#queue.push(item)
    if (this.#queue.length >= this.#o.maxBatch) this.#kick()
    else if (!this.#timer && !this.#sending) {
      this.#timer = setTimeout(() => this.#kick(), this.#o.delayMs)
      this.#timer.unref?.()
    }
  }

  #kick(): void {
    clearTimeout(this.#timer)
    this.#timer = undefined
    this.#sending ??= this.#loop().finally(() => {
      this.#sending = undefined
      if (this.#queue.length >= this.#o.maxBatch && !this.#closed) this.#kick()
    })
  }

  async #loop(): Promise<void> {
    // After the first batch, only full ones go at once; the rest wait for the delay or `close`.
    let first = true
    while (
      this.#queue.length &&
      (first || this.#draining || this.#queue.length >= this.#o.maxBatch)
    ) {
      first = false
      const batch = this.#queue.splice(0, this.#o.maxBatch)
      const why = await this.#send(batch)
      if (why) {
        this.#lost += batch.length
        this.#why ??= why
      }
    }
    if (this.#queue.length && !this.#draining) {
      this.#timer = setTimeout(() => this.#kick(), this.#o.delayMs)
      this.#timer.unref?.()
    }
  }

  /** Sends what's queued and takes no more; resolves to null, or to why some weren't sent. */
  async close(): Promise<string | null> {
    if (!this.#closed) {
      this.#closed = true
      this.#draining = true
      clearTimeout(this.#timer)
      this.#timer = undefined
      await this.#sending
      if (this.#queue.length) {
        this.#kick()
        await this.#sending
      }
    }
    if (!this.#lost) return null
    return `${this.#why} (${this.#lost} of ${this.#total} ${this.#noun} not sent)`
  }
}
