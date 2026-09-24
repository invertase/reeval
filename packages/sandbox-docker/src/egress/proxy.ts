import http, { type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'node:http'
import http2 from 'node:http2'
import https from 'node:https'
import net from 'node:net'
import type { Duplex } from 'node:stream'
import tls from 'node:tls'
import { type CertificateAuthority, issueServerCertificate } from './cert.ts'
import { link } from './mux.ts'
import { createPolicyCheck, type Lookup, type NetworkPolicy } from './policy.ts'
import { applyTransformations, decrypts, type RequestTransformation } from './rules.ts'

export type EgressProxyOptions = {
  ca: CertificateAuthority
  policy: NetworkPolicy
  /** One line per connection and per decrypted request. Never includes header values or bodies. */
  log?: (line: string) => void
  /** Extra roots for verifying upstream servers, e.g. a local test server's CA. */
  upstreamCA?: string
  lookup?: Lookup
  /** Let the gateway reach the host's loopback addresses. For tests only. */
  allowLoopback?: boolean
}

export type EgressProxy = {
  /** Serves one connection from the sandbox: an HTTP proxy client (CONNECT or absolute URLs). */
  handle(connection: Duplex): void
  addTransformations(rules: readonly RequestTransformation[]): void
  setTransformations(rules: readonly RequestTransformation[]): void
  setPolicy(policy: NetworkPolicy): void
  close(): void
}

type Target = { host: string; port: number; address: string }
/** HTTP/1.1 and HTTP/2 compatibility responses share this surface. */
type Response = http.ServerResponse

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authorization',
  'proxy-authenticate',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'http2-settings',
  'host',
])

const endToEnd = (headers: IncomingHttpHeaders | OutgoingHttpHeaders, keep: string[] = []) =>
  Object.fromEntries(
    Object.entries(headers).filter(
      ([k, v]) => v !== undefined && !k.startsWith(':') && (!HOP_BY_HOP.has(k) || keep.includes(k)),
    ),
  ) as OutgoingHttpHeaders

/** `host:port` from a CONNECT target or an authority, IPv6 in brackets. */
function parseAuthority(authority: string, defaultPort: number): { host: string; port: number } {
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(authority) ?? /^([^:]+)(?::(\d+))?$/.exec(authority)
  return { host: (m?.[1] ?? authority).toLowerCase(), port: Number(m?.[2] ?? defaultPort) }
}

const pathOnly = (path: string) => path.split('?')[0]

function reply(socket: Duplex, status: number, reason: string) {
  const text = http.STATUS_CODES[status] ?? ''
  socket.end(
    `HTTP/1.1 ${status} ${text}\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\n${reason}\n`,
  )
}

export function createEgressProxy(options: EgressProxyOptions): EgressProxy {
  const log = options.log ?? (() => {})
  let rules: RequestTransformation[] = []
  let check = createPolicyCheck(options.policy, options)
  const leaves = new Map<string, { key: string | Buffer; cert: string }>()
  const open = new Set<Duplex>()
  const sessions = new Map<string, http2.ClientHttp2Session>()
  const agent = new https.Agent({ keepAlive: true })
  const ca = options.upstreamCA ? [...tls.rootCertificates, options.upstreamCA] : undefined

  const track = <T extends Duplex>(s: T): T => {
    open.add(s)
    s.once('close', () => open.delete(s))
    return s
  }

  const credentialsFor = (host: string) => {
    let creds = leaves.get(host)
    if (!creds) {
      const leaf = issueServerCertificate(options.ca, host)
      creds = {
        key: leaf.key.export({ type: 'pkcs8', format: 'pem' }),
        cert: leaf.cert + options.ca.cert,
      }
      leaves.set(host, creds)
    }
    return creds
  }

  const front = http.createServer()
  front.on('connect', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const { host, port } = parseAuthority(req.url ?? '', 443)
    void check(host).then((verdict) => {
      if (!verdict.allowed) {
        log(`es:egress CONNECT ${host}:${port} denied (${verdict.reason})`)
        return reply(socket, verdict.status, `blocked by the ES egress policy: ${verdict.reason}`)
      }
      const target = { host, port, address: verdict.address }
      if (decrypts(rules, host)) {
        log(`es:egress CONNECT ${host}:${port} decrypt`)
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) socket.unshift(head)
        return decrypt(socket, target)
      }
      log(`es:egress CONNECT ${host}:${port} tunnel`)
      const upstream = track(net.connect({ host: target.address, port, allowHalfOpen: true }))
      upstream.once('connect', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        link(socket, upstream)
      })
      upstream.once('error', (error) => {
        log(`es:egress CONNECT ${host}:${port} failed (${error.message})`)
        reply(socket, 502, `ES egress gateway couldn't reach ${host}:${port}: ${error.message}`)
      })
    })
  })

  // Absolute-URL requests: plain HTTP through the proxy. Never given credentials.
  front.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
    let url: URL
    try {
      url = new URL(req.url ?? '')
    } catch {
      return res.writeHead(400).end('ES egress gateway: expected an absolute URL\n')
    }
    if (url.protocol !== 'http:') return res.writeHead(400).end('ES egress gateway: http only\n')
    const { host, port } = parseAuthority(url.host, 80)
    void check(host).then((verdict) => {
      if (!verdict.allowed) {
        log(`es:egress ${req.method} http://${host}:${port} denied (${verdict.reason})`)
        return res
          .writeHead(verdict.status)
          .end(`blocked by the ES egress policy: ${verdict.reason}\n`)
      }
      log(`es:egress ${req.method} http://${host}:${port}${url.pathname}`)
      const upstream = http.request({
        host: verdict.address,
        port,
        method: req.method,
        path: url.pathname + url.search,
        headers: { ...endToEnd(req.headers), host: url.host },
      })
      forwardHttp1(req, res, upstream)
    })
  })
  front.on('upgrade', (_req: http.IncomingMessage, socket: Duplex) => {
    reply(socket, 501, 'ES egress gateway: use CONNECT for websockets')
  })

  /**
   * Terminates TLS with a certificate for the CONNECT host. One server per connection, since the
   * host comes from CONNECT; it serves HTTP/2 and HTTP/1.1 (with upgrades) by ALPN.
   */
  function decrypt(socket: Duplex, target: Target) {
    const server = http2.createSecureServer(
      { ...credentialsFor(target.host), allowHTTP1: true },
      (req, res) => void onDecrypted(target, req, res as unknown as Response),
    )
    server.on('upgrade', (req: http.IncomingMessage, s: Duplex, head: Buffer) =>
      onUpgrade(target, req, track(s), head),
    )
    server.on('tlsClientError', () => socket.destroy())
    server.on('sessionError', () => socket.destroy())
    server.emit('connection', socket)
  }

  function transformed(
    target: Target,
    method: string,
    path: string,
    headers: IncomingHttpHeaders,
    version: string,
  ) {
    const { headers: out, replaced } = applyTransformations(rules, {
      host: target.host,
      method,
      path,
      headers: endToEnd(headers, ['upgrade', 'connection']) as IncomingHttpHeaders,
    })
    const set = replaced.length ? ` (set ${replaced.join(', ')})` : ''
    log(`es:egress ${method} https://${target.host}${pathOnly(path)} HTTP/${version}${set}`)
    return out as OutgoingHttpHeaders
  }

  async function onDecrypted(
    target: Target,
    req: http.IncomingMessage | http2.Http2ServerRequest,
    res: Response,
  ) {
    const method = req.method ?? 'GET'
    const path = req.url ?? '/'
    const headers = transformed(target, method, path, req.headers, req.httpVersion)
    delete headers.upgrade
    delete headers.connection
    const authority = target.port === 443 ? target.host : `${target.host}:${target.port}`
    const session = req.httpVersionMajor === 2 ? await upstreamSession(target) : null
    if (!session) {
      const upstream = https.request({
        host: target.address,
        servername: net.isIP(target.host) ? undefined : target.host,
        port: target.port,
        method,
        path,
        headers: { ...headers, host: authority },
        agent,
        ca,
      })
      return forwardHttp1(req, res, upstream)
    }
    const stream = session.request({
      ...headers,
      ':method': method,
      ':path': path,
      ':scheme': 'https',
      ':authority': authority,
    })
    const fail = (error: Error) => {
      if (!res.headersSent) res.writeHead(502).end(`ES egress gateway: ${error.message}\n`)
      else res.destroy()
    }
    stream.once('error', fail)
    stream.once('response', (h) => {
      res.writeHead(Number(h[':status']), endToEnd(h))
      stream.once('trailers', (t) => res.addTrailers(endToEnd(t) as Record<string, string>))
      stream.pipe(res)
    })
    req.pipe(stream)
    req.once('aborted', () => stream.close(http2.constants.NGHTTP2_CANCEL))
  }

  function forwardHttp1(
    req: http.IncomingMessage | http2.Http2ServerRequest,
    res: Response,
    upstream: http.ClientRequest,
  ) {
    upstream.once('response', (up) => {
      res.writeHead(up.statusCode ?? 502, endToEnd(up.headers))
      up.once('end', () => {
        if (Object.keys(up.trailers).length) res.addTrailers(up.trailers as Record<string, string>)
      })
      up.pipe(res)
    })
    upstream.once('error', (error) => {
      if (!res.headersSent) res.writeHead(502).end(`ES egress gateway: ${error.message}\n`)
      else res.destroy()
    })
    req.pipe(upstream)
  }

  function onUpgrade(target: Target, req: http.IncomingMessage, socket: Duplex, head: Buffer) {
    const method = req.method ?? 'GET'
    const path = req.url ?? '/'
    const headers = transformed(target, method, path, req.headers, req.httpVersion)
    const upstream = https.request({
      host: target.address,
      servername: net.isIP(target.host) ? undefined : target.host,
      port: target.port,
      method,
      path,
      headers: { ...headers, host: target.host },
      ca,
    })
    upstream.once('upgrade', (up, upSocket: Duplex, upHead: Buffer) => {
      const lines = [`HTTP/1.1 ${up.statusCode} ${up.statusMessage}`]
      for (let i = 0; i < up.rawHeaders.length; i += 2) {
        lines.push(`${up.rawHeaders[i]}: ${up.rawHeaders[i + 1]}`)
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (upHead.length) socket.write(upHead)
      if (head.length) upSocket.write(head)
      link(socket, track(upSocket))
    })
    upstream.once('response', (up) => {
      reply(socket, up.statusCode ?? 502, `upstream refused the upgrade (${up.statusCode})`)
      up.resume()
    })
    upstream.once('error', (error) => reply(socket, 502, `ES egress gateway: ${error.message}`))
    upstream.end()
  }

  /** One HTTP/2 session per upstream, or null when it doesn't speak h2. */
  function upstreamSession(target: Target): Promise<http2.ClientHttp2Session | null> {
    const key = `${target.host}:${target.port}`
    const existing = sessions.get(key)
    if (existing && !existing.closed && !existing.destroyed) return Promise.resolve(existing)
    return new Promise((resolve) => {
      const socket = tls.connect({
        host: target.address,
        port: target.port,
        servername: net.isIP(target.host) ? undefined : target.host,
        ALPNProtocols: ['h2', 'http/1.1'],
        ...(ca ? { ca } : {}),
      })
      socket.once('error', () => resolve(null))
      socket.once('secureConnect', () => {
        if (socket.alpnProtocol !== 'h2') {
          socket.destroy()
          return resolve(null)
        }
        const session = http2.connect(`https://${key}`, { createConnection: () => socket })
        session.on('error', () => {})
        session.once('close', () => sessions.get(key) === session && sessions.delete(key))
        session.once('goaway', () => sessions.get(key) === session && sessions.delete(key))
        sessions.set(key, session)
        resolve(session)
      })
    })
  }

  return {
    handle(connection) {
      track(connection)
      connection.on('error', () => connection.destroy())
      front.emit('connection', connection)
    },
    addTransformations(more) {
      rules = [...rules, ...more]
    },
    setTransformations(all) {
      rules = [...all]
    },
    setPolicy(policy) {
      check = createPolicyCheck(policy, options)
    },
    close() {
      for (const s of open) s.destroy()
      for (const s of sessions.values()) s.destroy()
      sessions.clear()
      agent.destroy()
    },
  }
}
