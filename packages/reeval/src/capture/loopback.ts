import http from 'node:http'
import net from 'node:net'
import type { Duplex } from 'node:stream'

/** `localhost`, `*.localhost`, `127.0.0.0/8` and `::1`: the names a page means the sandbox by. */
export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true
  return net.isIPv4(h) && h.startsWith('127.')
}

type Target = { host: string; port: number }

export type LoopbackProxy = {
  /** `127.0.0.1:<port>`, for Chrome's `--proxy-server`. */
  readonly address: string
  /** The sandbox ports the page reached through it, in the order it first asked for each. */
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

/**
 * The capture browser's HTTP proxy, on the host's loopback. Chrome sends it every request
 * (`--proxy-bypass-list=<-loopback>`): one for a loopback address goes into the sandbox, to that
 * port through its tunnel, opened on first use; everything else goes out as it would without a
 * proxy, so the page reaches the internet as before.
 */
export async function startLoopbackProxy(options: LoopbackProxyOptions): Promise<LoopbackProxy> {
  const direct = new Set(options.direct)
  const reached: number[] = []
  const tunnels = new Map<number, Promise<Target>>()
  const sockets = new Set<Duplex>()
  const track = (s: Duplex) => {
    sockets.add(s)
    s.once('close', () => sockets.delete(s))
  }

  const resolve = (to: Target): Promise<Target> => {
    if (!isLoopbackHost(to.host) || direct.has(to.port)) return Promise.resolve(to)
    let open = tunnels.get(to.port)
    if (!open) {
      if (!reached.includes(to.port)) reached.push(to.port)
      open = options.tunnel(to.port).then((url) => {
        const at = new URL(url)
        direct.add(Number(at.port))
        return { host: at.hostname, port: Number(at.port) }
      })
      open.catch(() => tunnels.delete(to.port))
      tunnels.set(to.port, open)
    }
    return open
  }

  const connect = async (to: Target): Promise<net.Socket> => {
    const at = await resolve(to)
    return new Promise((ok, fail) => {
      const socket = net.connect({ host: at.host, port: at.port, allowHalfOpen: true })
      socket.once('connect', () => {
        socket.off('error', fail)
        ok(socket)
      })
      socket.once('error', fail)
    })
  }

  const pipe = (a: Duplex, b: Duplex) => {
    track(b)
    a.on('error', () => b.destroy())
    b.on('error', () => a.destroy())
    a.pipe(b)
    b.pipe(a)
  }

  /** A request in absolute form, written out again in origin form on a raw connection. */
  const head = (req: http.IncomingMessage, url: URL) => {
    const lines = [`${req.method} ${url.pathname}${url.search} HTTP/${req.httpVersion}`]
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i] ?? ''
      if (/^proxy-/i.test(name)) continue
      lines.push(`${name}: ${req.rawHeaders[i + 1]}`)
    }
    return `${lines.join('\r\n')}\r\n\r\n`
  }

  const server = http.createServer((req, res) => {
    const url = URL.canParse(req.url ?? '') ? new URL(req.url ?? '') : undefined
    const to = url && authority(url.host)
    if (!url || !to || url.protocol !== 'http:') {
      res.writeHead(400).end()
      return
    }
    void resolve(to)
      .then((at) => {
        const headers = { ...req.headers }
        delete headers['proxy-connection']
        delete headers['proxy-authorization']
        const upstream = http.request(
          {
            host: at.host,
            port: at.port,
            method: req.method,
            path: `${url.pathname}${url.search}`,
            headers,
            agent: false,
          },
          (up) => {
            res.writeHead(up.statusCode ?? 502, up.rawHeaders)
            up.pipe(res)
          },
        )
        upstream.on('error', () => {
          if (!res.headersSent) res.writeHead(502)
          res.destroy()
        })
        req.pipe(upstream)
      })
      .catch(() => res.writeHead(502).end())
  })
  server.on('connection', track)

  server.on('connect', (req: http.IncomingMessage, client: Duplex, early: Buffer) => {
    const to = authority(req.url ?? '')
    if (!to) {
      client.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return
    }
    connect(to)
      .then((socket) => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (early.length) socket.write(early)
        pipe(client, socket)
      })
      .catch(() => client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'))
  })

  server.on('upgrade', (req: http.IncomingMessage, client: Duplex, early: Buffer) => {
    const url = URL.canParse(req.url ?? '') ? new URL(req.url ?? '') : undefined
    const to = url && authority(url.host)
    if (!url || !to) {
      client.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return
    }
    connect(to)
      .then((socket) => {
        socket.write(head(req, url))
        if (early.length) socket.write(early)
        pipe(client, socket)
      })
      .catch(() => client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'))
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
        for (const s of sockets) s.destroy()
        server.close(() => ok())
      }),
  }
}
