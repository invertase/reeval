import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export type Seen = {
  method: string
  path: string
  query: Record<string, string>
  authorization: string | undefined
  contentType: string | undefined
  headers: IncomingMessage['headers']
  body: string
}

type Reply = {
  status?: number
  json?: unknown
  text?: string
  headers?: Record<string, string>
  /** Sends the headers and half the body, then the rest this long after; `Infinity` never does. */
  stallMs?: number
}
type Handler = (req: Seen) => Reply | 'hang' | Promise<Reply | 'hang'>

/** A local HTTP server that answers with `handler` and records every request it gets. */
export async function fakePlatform(handler: Handler) {
  const seen: Seen[] = []
  const open = new Set<ServerResponse>()
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const url = new URL(req.url ?? '/', 'http://x')
    const s: Seen = {
      method: req.method ?? '',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      authorization: req.headers.authorization,
      contentType: req.headers['content-type'],
      headers: req.headers,
      body: Buffer.concat(chunks).toString(),
    }
    seen.push(s)
    const reply = await handler(s)
    if (reply === 'hang') {
      open.add(res)
      return
    }
    const body = reply.json !== undefined ? JSON.stringify(reply.json) : (reply.text ?? '')
    res.writeHead(reply.status ?? 200, {
      ...(reply.json !== undefined && { 'content-type': 'application/json' }),
      ...reply.headers,
    })
    if (reply.stallMs === undefined) {
      res.end(body)
      return
    }
    res.write(body.slice(0, Math.floor(body.length / 2)))
    open.add(res)
    if (reply.stallMs === Number.POSITIVE_INFINITY) return
    setTimeout(() => {
      open.delete(res)
      res.end(body.slice(Math.floor(body.length / 2)))
    }, reply.stallMs)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    async close() {
      for (const res of open) res.destroy()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
