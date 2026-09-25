import http, { type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'node:http'
import http2 from 'node:http2'
import https from 'node:https'
import net from 'node:net'
import type { Duplex, Readable, Transform } from 'node:stream'
import tls from 'node:tls'
import { type CertificateAuthority, issueServerCertificate } from './cert.ts'
import { link } from './mux.ts'
import { createPolicyCheck, hostAllowed, type Lookup, type NetworkPolicy } from './policy.ts'
import {
  applyTransformations,
  decrypts,
  type EndpointMatch,
  onEndpoint,
  type RequestTransformation,
} from './rules.ts'
import {
  bodySubstituter,
  type SubstituteIn,
  type Substitution,
  scrubbedInBodies,
  scrubber,
  scrubHeaders,
  substituteRequest,
  substitutes,
  substitutionsFor,
  unsubstituted,
} from './substitution.ts'
import { type DerivedTokens, tokeniseResponse } from './tokens.ts'

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
  /** `false` sends responses from brokered hosts back unscrubbed. For tests only. */
  scrubResponses?: boolean
  /**
   * The only requests a credential may be swapped into. A request a transformation matches that
   * isn't one of them gets a 403 from the gateway, not the placeholder sent upstream.
   */
  endpoints?: readonly EndpointMatch[]
  /** Called for each request refused under `endpoints`, e.g. to warn outside `ES_DEBUG`. */
  onRefused?: (request: { method: string; url: string }) => void
  /**
   * Called when a request to a brokered secret's host carries its placeholder somewhere the
   * secret doesn't substitute (see `unsubstituted`), so it goes upstream as the placeholder.
   */
  onUnsubstituted?: (event: {
    name: string
    where: SubstituteIn
    in: readonly SubstituteIn[]
    method: string
    url: string
  }) => void
  /**
   * Tokens the agent derives from its brokered key. Their exchange's response reaches the sandbox
   * with placeholders, and the real tokens are swapped back in on their hosts, in headers only.
   */
  derivedTokens?: readonly DerivedTokens[]
}

/**
 * A host the sandbox reached through the gateway. `sent` and `received` are the bytes between the
 * sandbox and the gateway after the policy let the connection through, TLS included.
 */
export type ContactedHost = {
  host: string
  port: number
  connections: number
  sent: number
  received: number
}
/** A host the policy refused, and why. */
export type BlockedHost = { host: string; port: number; connections: number; reason: string }
/** What went through the gateway, sorted by host and port. */
export type EgressTraffic = { contacted: ContactedHost[]; blocked: BlockedHost[] }

export type EgressProxy = {
  /** Serves one connection from the sandbox: an HTTP proxy client (CONNECT or absolute URLs). */
  handle(connection: Duplex): void
  traffic(): EgressTraffic
  addTransformations(rules: readonly RequestTransformation[]): void
  setTransformations(rules: readonly RequestTransformation[]): void
  setPolicy(policy: NetworkPolicy): void
  /** Replaces the brokered secrets: each swapped in only on HTTPS to its own hosts. */
  setSubstitutions(subs: readonly Substitution[]): void
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
  let subs: Substitution[] = []
  /** Substitutions for derived tokens, added as their exchanges answer; kept by setSubstitutions. */
  let tokens: Substitution[] = []
  const allSubs = () => (tokens.length ? [...subs, ...tokens] : subs)
  const derived = options.derivedTokens ?? []
  const tokenHosts = derived.flatMap((d) => [d.endpoint.host, ...d.hosts])
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

  const contacted = new Map<string, ContactedHost>()
  const blocked = new Map<string, BlockedHost>()
  /** The host each sandbox connection's bytes count towards: its latest allowed request's. */
  const counting = new WeakMap<Duplex, ContactedHost>()
  /** Bytes a connection sent before the policy decided whose they are: the request itself. */
  const unclaimed = new WeakMap<Duplex, number>()
  const contact = (connection: Duplex, host: string, port: number) => {
    const key = `${host}:${port}`
    let entry = contacted.get(key)
    if (!entry) {
      entry = { host, port, connections: 0, sent: 0, received: 0 }
      contacted.set(key, entry)
    }
    entry.connections++
    entry.sent += unclaimed.get(connection) ?? 0
    unclaimed.delete(connection)
    counting.set(connection, entry)
  }
  const block = (connection: Duplex, host: string, port: number, reason: string) => {
    const key = `${host}:${port}`
    const entry = blocked.get(key) ?? { host, port, connections: 0, reason }
    entry.connections++
    blocked.set(key, entry)
    counting.delete(connection)
    unclaimed.delete(connection)
  }
  /** Counts what the connection carries each way, without reading it or changing its flow. */
  const countBytes = (connection: Duplex) => {
    const push = connection.push.bind(connection)
    connection.push = (chunk: unknown, encoding?: BufferEncoding) => {
      const entry = counting.get(connection)
      const n = chunk ? Buffer.byteLength(chunk as Buffer) : 0
      if (entry) entry.sent += n
      else unclaimed.set(connection, (unclaimed.get(connection) ?? 0) + n)
      return push(chunk, encoding)
    }
    const write = connection.write.bind(connection) as (...args: unknown[]) => boolean
    connection.write = ((chunk: unknown, ...rest: unknown[]) => {
      const entry = counting.get(connection)
      if (entry && chunk) entry.received += Buffer.byteLength(chunk as Buffer)
      return write(chunk, ...rest)
    }) as Duplex['write']
  }
  const byHost = <T extends { host: string; port: number }>(entries: Iterable<T>) =>
    [...entries]
      .map((e) => ({ ...e }))
      .sort((a, b) => a.host.localeCompare(b.host) || a.port - b.port)

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
        if (verdict.status === 403) block(socket, host, port, verdict.reason)
        else contact(socket, host, port)
        return reply(socket, verdict.status, `blocked by the ES egress policy: ${verdict.reason}`)
      }
      contact(socket, host, port)
      const target = { host, port, address: verdict.address }
      if (decrypts(rules, host) || substitutes(allSubs(), host) || hostAllowed(tokenHosts, host)) {
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

  // Absolute-URL requests: plain HTTP through the proxy. Never given credentials or substitutions,
  // so a placeholder sent over plain HTTP goes out as the placeholder.
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
        if (verdict.status === 403) block(req.socket, host, port, verdict.reason)
        else contact(req.socket, host, port)
        return res
          .writeHead(verdict.status)
          .end(`blocked by the ES egress policy: ${verdict.reason}\n`)
      }
      log(`es:egress ${req.method} http://${host}:${port}${url.pathname}`)
      contact(req.socket, host, port)
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

  /**
   * The headers and path to send upstream, the substitutions that apply there, or why the request
   * is refused (already logged): a Host that isn't the CONNECT target, or an unbrokered endpoint.
   */
  function transformed(
    target: Target,
    method: string,
    path: string,
    headers: IncomingHttpHeaders,
    version: string,
  ): {
    headers: OutgoingHttpHeaders
    path: string
    own: Substitution[]
    refused?: { status: number; reason: string }
    /** Set when this is a token exchange, whose response gets placeholders for its tokens. */
    exchange?: DerivedTokens
  } {
    const named = String(headers[':authority'] ?? headers.host ?? '')
    const asked = parseAuthority(named, target.port).host
    if (named && asked !== target.host) {
      const reason = `ES egress gateway: the request names ${asked}, but the connection is to ${target.host}; send it on a connection to ${asked}.`
      log(`es:egress ${method} https://${target.host}${pathOnly(path)} refused (Host ${asked})`)
      return { headers: {}, path, own: [], refused: { status: 421, reason } }
    }
    const {
      headers: out,
      replaced,
      refused,
    } = applyTransformations(
      rules,
      {
        host: target.host,
        method,
        path,
        headers: endToEnd(headers, ['upgrade', 'connection']) as IncomingHttpHeaders,
      },
      options.endpoints,
    )
    const url = `https://${target.host}${pathOnly(path)}`
    if (refused) {
      log(`es:egress ${method} ${url} HTTP/${version} refused (not a brokered endpoint)`)
      options.onRefused?.({ method, url })
      return {
        headers: {},
        path,
        own: [],
        refused: {
          status: 403,
          reason: `ES egress gateway: refused ${method} ${url}. It carries a brokered credential, and it isn't one of the endpoints ES brokers it for.`,
        },
      }
    }
    const own = substitutionsFor(allSubs(), target.host)
    const request = { host: target.host, path, headers: out as IncomingHttpHeaders }
    const substituted = substituteRequest(own, request)
    const kept = unsubstituted(own, request)
    for (const k of kept) options.onUnsubstituted?.({ ...k, method, url })
    const exchange = derived.find((d) =>
      onEndpoint([d.endpoint], { host: target.host, method, path, headers: {} }),
    )
    // Uncompressed responses, so the scrubber and the tokeniser can see what comes back.
    if (scrubbedInBodies(own).length || exchange) delete substituted.headers['accept-encoding']
    const notes = [
      replaced.length ? `set ${replaced.join(', ')}` : '',
      substituted.names.length ? `substituted ${substituted.names.join(', ')}` : '',
      ...kept.map((k) => `kept ${k.name}'s placeholder in the ${k.where}`),
    ].filter(Boolean)
    log(`es:egress ${method} ${url} HTTP/${version}${notes.length ? ` (${notes.join('; ')})` : ''}`)
    return {
      headers: substituted.headers as OutgoingHttpHeaders,
      path: substituted.path,
      own,
      ...(exchange ? { exchange } : {}),
    }
  }

  /**
   * The request body as sent upstream: through the substituter when a secret there opts in to
   * bodies, unless the body is encoded (gzip and the like), which is sent as is and fails closed.
   */
  function requestBody(
    req: Readable,
    headers: OutgoingHttpHeaders,
    own: Substitution[],
  ): Readable | Transform {
    const encoded = String(headers['content-encoding'] ?? 'identity') !== 'identity'
    if (encoded || !own.some((s) => s.in.includes('body'))) return req
    delete headers['content-length']
    return req.pipe(bodySubstituter(own))
  }

  /** The response body as sent to the sandbox: real values put back as placeholders. */
  const scrubs = options.scrubResponses !== false
  function responseBody(up: Readable, own: Substitution[]): Readable | Transform {
    return scrubbedInBodies(own).length && scrubs ? up.pipe(scrubber(own)) : up
  }

  const responseHeaders = (headers: IncomingHttpHeaders, own: Substitution[]) => {
    const out = endToEnd(headers)
    if (!own.length || !scrubs) return out
    if (scrubbedInBodies(own).length) delete out['content-length']
    return scrubHeaders(own, out as Record<string, string>) as OutgoingHttpHeaders
  }

  /** Most an exchange's response may be; it's a few hundred bytes of JSON. */
  const EXCHANGE_LIMIT = 1 << 20

  /**
   * A token exchange's response, read whole, with each token replaced by a placeholder. A success
   * that can't be read (compressed, too big, not JSON) is a 502: the real tokens never go through.
   */
  function tokenised(
    exchange: DerivedTokens,
    url: string,
    status: number,
    headers: IncomingHttpHeaders,
    up: Readable,
    res: Response,
    own: Substitution[],
  ) {
    const chunks: Buffer[] = []
    let size = 0
    const refuse = (why: string) => {
      log(`es:egress ${url} response refused (${why})`)
      if (!res.headersSent) {
        res
          .writeHead(502, { 'content-type': 'text/plain' })
          .end(`ES egress gateway: couldn't keep ${exchange.name}'s tokens out of the sandbox: ${why}
`)
      } else res.destroy()
    }
    const scrubbed = responseBody(up, own)
    scrubbed.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size <= EXCHANGE_LIMIT) chunks.push(chunk)
    })
    up.once('error', (error) => refuse(error.message))
    scrubbed.once('end', () => {
      const body = Buffer.concat(chunks)
      const out = responseHeaders(headers, own)
      if (status < 200 || status >= 300) return res.writeHead(status, out).end(body)
      const encoding = String(headers['content-encoding'] ?? 'identity')
      if (encoding !== 'identity') return refuse(`the response is ${encoding}-encoded`)
      if (size > EXCHANGE_LIMIT) return refuse(`the response is over ${EXCHANGE_LIMIT} bytes`)
      let result: ReturnType<typeof tokeniseResponse>
      try {
        result = tokeniseResponse(exchange, body.toString('utf8'), tokens)
      } catch (error) {
        return refuse((error as Error).message)
      }
      tokens = [...tokens, ...result.added]
      log(`es:egress ${url} tokenised ${result.fields.join(', ') || 'nothing'} (${exchange.name})`)
      const text = Buffer.from(result.body)
      delete out['content-encoding']
      res.writeHead(status, { ...out, 'content-length': String(text.length) }).end(text)
    })
  }

  async function onDecrypted(
    target: Target,
    req: http.IncomingMessage | http2.Http2ServerRequest,
    res: Response,
  ) {
    const method = req.method ?? 'GET'
    const { headers, path, own, refused, exchange } = transformed(
      target,
      method,
      req.url ?? '/',
      req.headers,
      req.httpVersion,
    )
    const url = `https://${target.host}${pathOnly(req.url ?? '/')}`
    if (refused) {
      req.resume()
      return res
        .writeHead(refused.status, { 'content-type': 'text/plain' })
        .end(`${refused.reason}\n`)
    }
    delete headers.upgrade
    delete headers.connection
    const body = requestBody(req as Readable, headers, own)
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
      return forwardHttp1(body, res, upstream, own, exchange && { exchange, url })
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
      if (exchange) return tokenised(exchange, url, Number(h[':status']), h, stream, res, own)
      res.writeHead(Number(h[':status']), responseHeaders(h, own))
      stream.once('trailers', (t) =>
        res.addTrailers(responseHeaders(t, own) as Record<string, string>),
      )
      responseBody(stream, own).pipe(res)
    })
    body.pipe(stream)
    req.once('aborted', () => stream.close(http2.constants.NGHTTP2_CANCEL))
  }

  function forwardHttp1(
    req: Readable,
    res: Response,
    upstream: http.ClientRequest,
    own: Substitution[] = [],
    tokenise?: { exchange: DerivedTokens; url: string },
  ) {
    upstream.once('response', (up) => {
      if (tokenise) {
        const { exchange, url } = tokenise
        return tokenised(exchange, url, up.statusCode ?? 502, up.headers, up, res, own)
      }
      res.writeHead(up.statusCode ?? 502, responseHeaders(up.headers, own))
      up.once('end', () => {
        if (Object.keys(up.trailers).length) {
          res.addTrailers(responseHeaders(up.trailers, own) as Record<string, string>)
        }
      })
      responseBody(up, own).pipe(res)
    })
    upstream.once('error', (error) => {
      if (!res.headersSent) res.writeHead(502).end(`ES egress gateway: ${error.message}\n`)
      else res.destroy()
    })
    req.pipe(upstream)
  }

  function onUpgrade(target: Target, req: http.IncomingMessage, socket: Duplex, head: Buffer) {
    const method = req.method ?? 'GET'
    const { headers, path, refused } = transformed(
      target,
      method,
      req.url ?? '/',
      req.headers,
      req.httpVersion,
    )
    if (refused) return reply(socket, refused.status, refused.reason)
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
      countBytes(connection)
      connection.on('error', () => connection.destroy())
      front.emit('connection', connection)
    },
    traffic: () => ({ contacted: byHost(contacted.values()), blocked: byHost(blocked.values()) }),
    addTransformations(more) {
      rules = [...rules, ...more]
    },
    setTransformations(all) {
      rules = [...all]
    },
    setPolicy(policy) {
      check = createPolicyCheck(policy, options)
    },
    setSubstitutions(all) {
      subs = [...all]
    },
    close() {
      for (const s of open) s.destroy()
      for (const s of sessions.values()) s.destroy()
      sessions.clear()
      agent.destroy()
    },
  }
}
