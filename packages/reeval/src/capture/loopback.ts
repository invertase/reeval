import http from 'node:http'
import net from 'node:net'
import type { Duplex } from 'node:stream'

/**
 * `localhost`, `*.localhost`, `127.0.0.0/8`, `::1`, their IPv4-mapped IPv6 form and the
 * unspecified addresses, with or without a trailing dot: the names a page means the sandbox by.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (net.isIPv4(h)) return h.startsWith('127.') || h === '0.0.0.0'
  if (!net.isIPv6(h)) return false
  if (h === '::1' || h === '::') return true
  const mapped = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):[0-9a-f]{1,4})$/.exec(h)
  if (!mapped) return false
  return mapped[1]
    ? mapped[1].startsWith('127.')
    : Number.parseInt(mapped[2] ?? '', 16) >> 8 === 0x7f
}

type Target = { host: string; port: number }
/** Where a request goes, and the sandbox port it's for when it goes through a tunnel. */
type Route = Target & { sandbox?: number }

export type LoopbackProxy = {
  /** `127.0.0.1:<port>`, for Chrome's `--proxy-server`. */
  readonly address: string
  /** The sandbox ports that answered the page, in the order each first did. */
  readonly reached: readonly number[]
  close(): Promise<void>
}

export type LoopbackProxyOptions = {
  /** A host URL that reaches `port` inside the sandbox (the sandbox's port tunnel). */
  tunnel(port: number): Promise<string>
  /** Host loopback ports that are the host's own: the served page's tunnel, reached as they are. */
  direct: readonly number[]
}

function authority(value: string): Target | undefined {
  if (!URL.canParse(`http://${value}`)) return undefined
  const url = new URL(`http://${value}`)
  return { host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port) || 80 }
}

/** `rawHeaders` without the ones meant for the proxy, in the flat form `http.request` takes. */
function forwarded(raw: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i] ?? ''
    if (!/^proxy-/i.test(name)) out.push(name, raw[i + 1] ?? '')
  }
  return out
}

/**
 * The capture browser's HTTP proxy, on the host's loopback. Chrome sends it every request
 * (`--proxy-bypass-list=<-loopback>`): one for a loopback address goes into the sandbox, to that
 * port through its tunnel, opened on first use; everything else goes out as it would without a
 * proxy, so the page reaches the internet as before.
 *
 * A plain-HTTP request that gets no response (nothing listens on that sandbox port) drops the
 * page's connection rather than answering, so the page's fetch fails as a refused one does. A
 * CONNECT to such a port is answered and then closed: the tunnel accepts before the sandbox side
 * connects, and Chrome fails that request too.
 */
export async function startLoopbackProxy(options: LoopbackProxyOptions): Promise<LoopbackProxy> {
  const direct = new Set(options.direct)
  const reached: number[] = []
  const tunnels = new Map<number, Promise<Target>>()
  const live = new Set<{ destroy(): unknown }>()
  let closed = false
  const track = <T extends { destroy(): unknown; once(e: 'close', f: () => void): unknown }>(
    s: T,
  ): T => {
    live.add(s)
    s.once('close', () => live.delete(s))
    return s
  }
  const answered = (route: Route) => {
    if (route.sandbox !== undefined && !reached.includes(route.sandbox)) reached.push(route.sandbox)
  }

  const resolve = async (to: Target): Promise<Route> => {
    if (!isLoopbackHost(to.host) || direct.has(to.port)) return to
    let open = tunnels.get(to.port)
    if (!open) {
      open = options.tunnel(to.port).then((url) => {
        const at = new URL(url)
        direct.add(Number(at.port))
        return { host: at.hostname, port: Number(at.port) }
      })
      open.catch(() => tunnels.delete(to.port))
      tunnels.set(to.port, open)
    }
    return { ...(await open), sandbox: to.port }
  }

  const connect = async (to: Target): Promise<{ socket: net.Socket; route: Route }> => {
    const route = await resolve(to)
    if (closed) throw new Error('the capture proxy closed')
    return new Promise((ok, fail) => {
      const socket = track(net.connect({ host: route.host, port: route.port, allowHalfOpen: true }))
      socket.once('connect', () => {
        socket.off('error', fail)
        ok({ socket, route })
      })
      socket.once('error', fail)
    })
  }

  /** Joins the page's connection to the upstream one, unless the page left while it opened. */
  const join = (client: Duplex, socket: net.Socket, route: Route): boolean => {
    if (closed || client.destroyed) {
      socket.destroy()
      return false
    }
    socket.once('data', () => answered(route))
    socket.on('error', () => client.destroy())
    client.on('error', () => socket.destroy())
    client.once('close', () => socket.destroy())
    socket.once('close', () => client.destroy())
    client.pipe(socket)
    socket.pipe(client)
    return true
  }

  const server = http.createServer((req, res) => {
    const url = URL.canParse(req.url ?? '') ? new URL(req.url ?? '') : undefined
    const to = url && authority(url.host)
    if (!url || !to || url.protocol !== 'http:') {
      res.writeHead(400).end()
      return
    }
    const drop = () => req.socket.destroy()
    resolve(to)
      .then((route) => {
        if (closed || res.destroyed) return drop()
        const upstream = http.request(
          {
            host: route.host,
            port: route.port,
            method: req.method,
            path: `${url.pathname}${url.search}`,
            headers: forwarded(req.rawHeaders),
            agent: false,
          },
          (up) => {
            answered(route)
            res.writeHead(up.statusCode ?? 502, up.statusMessage, up.rawHeaders)
            up.pipe(res)
          },
        )
        track(upstream)
        res.once('close', () => upstream.destroy())
        upstream.on('error', drop)
        req.pipe(upstream)
      })
      .catch(drop)
  })
  server.on('connection', track)

  server.on('connect', (req: http.IncomingMessage, client: Duplex, early: Buffer) => {
    client.on('error', () => client.destroy())
    const to = authority(req.url ?? '')
    if (!to) {
      client.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return
    }
    connect(to)
      .then(({ socket, route }) => {
        if (!join(client, socket, route)) return
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (early.length) socket.write(early)
      })
      .catch(() => {
        if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      })
  })

  server.on('upgrade', (req: http.IncomingMessage, client: Duplex, early: Buffer) => {
    client.on('error', () => client.destroy())
    const url = URL.canParse(req.url ?? '') ? new URL(req.url ?? '') : undefined
    const to = url && authority(url.host)
    if (!url || !to) {
      client.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return
    }
    const headers = forwarded(req.rawHeaders)
    const lines = [`${req.method} ${url.pathname}${url.search} HTTP/${req.httpVersion}`]
    for (let i = 0; i < headers.length; i += 2) lines.push(`${headers[i]}: ${headers[i + 1]}`)
    connect(to)
      .then(({ socket, route }) => {
        if (!join(client, socket, route)) return
        socket.write(`${lines.join('\r\n')}\r\n\r\n`)
        if (early.length) socket.write(early)
      })
      .catch(() => {
        if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      })
  })

  await new Promise<void>((ok, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => ok())
  })
  const { port } = server.address() as net.AddressInfo
  return {
    address: `127.0.0.1:${port}`,
    reached,
    close: () =>
      new Promise<void>((ok) => {
        closed = true
        for (const s of live) s.destroy()
        server.close(() => ok())
      }),
  }
}
