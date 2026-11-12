// A stub `fetch` for the adapters: it records each request and answers from `answer`.
export type Sent = {
  method: string
  url: URL
  headers: Record<string, string>
  body: unknown
}

export type Reply = { status?: number; body?: unknown; headers?: Record<string, string> }

export function stubFetch(answer: (sent: Sent) => Reply | Promise<Reply>) {
  const sent: Sent[] = []
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const headers: Record<string, string> = {}
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value
    })
    const request: Sent = {
      method: init.method ?? 'GET',
      url: new URL(String(input)),
      headers,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    }
    sent.push(request)
    init.signal?.throwIfAborted()
    const reply = await answer(request)
    const status = reply.status ?? 200
    return new Response(
      reply.body === undefined || status === 204 ? null : JSON.stringify(reply.body),
      { status, headers: { 'content-type': 'application/json', ...reply.headers } },
    )
  }) as typeof globalThis.fetch
  return { fetch, sent }
}
