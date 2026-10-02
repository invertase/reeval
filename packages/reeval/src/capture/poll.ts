/** Any HTTP response, including 404, means something accepted the connection. */
export async function pollHttp(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  while (Date.now() < deadline) {
    signal?.throwIfAborted()
    const left = Math.max(1, deadline - Date.now())
    try {
      await fetch(url, {
        signal: AbortSignal.any([
          AbortSignal.timeout(Math.min(1000, left)),
          ...(signal ? [signal] : []),
        ]),
      })
      return
    } catch (error) {
      last = error
      if (signal?.aborted) throw error
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  throw last instanceof Error ? last : new Error('poll timed out')
}
