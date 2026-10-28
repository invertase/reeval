/** A dev server still starting (Nuxt's loading page) or a proxy whose upstream isn't up yet. */
const STARTING = new Set([502, 503, 504])

/**
 * Any HTTP response, including 404, means something accepted the connection. A 502, 503 or 504
 * is polled past until the deadline, and then taken as it is.
 */
export async function pollHttp(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  let answered = false
  while (Date.now() < deadline) {
    signal?.throwIfAborted()
    const left = Math.max(1, deadline - Date.now())
    try {
      const res = await fetch(url, {
        signal: AbortSignal.any([
          AbortSignal.timeout(Math.min(1000, left)),
          ...(signal ? [signal] : []),
        ]),
      })
      await res.body?.cancel()
      if (!STARTING.has(res.status)) return
      answered = true
    } catch (error) {
      last = error
      if (signal?.aborted) throw error
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  if (answered) return
  throw last instanceof Error ? last : new Error('poll timed out')
}
