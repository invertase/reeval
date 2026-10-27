import http, { type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'node:http'
import http2 from 'node:http2'
import https from 'node:https'
import net from 'node:net'
import { Duplex, type Readable, Transform } from 'node:stream'
import tls from 'node:tls'
import zlib from 'node:zlib'
import { type CertificateAuthority, issueServerCertificate } from './cert.ts'
import { requestedEffort } from './effort.ts'
import { link } from './mux.ts'
import { createPolicyCheck, hostAllowed, type Lookup, type NetworkPolicy } from './policy.ts'
import {
  applyTransformations,
  credentialValues,
  decrypts,
  type EndpointMatch,
  onEndpoint,
  type RequestTransformation,
  setsCredential,
} from './rules.ts'
import {
  bodySubstituter,
  type SubstituteIn,
  type Substitution,
  scrubbedInBodies,
  scrubber,
  scrubHeaders,
  scrubValue,
  substituteRequest,
  substitutes,
  substitutionsFor,
  unsubstituted,
} from './substitution.ts'
import { type DerivedTokens, tokenizeResponse } from './tokens.ts'
import { webSocketScrubber } from './websocket.ts'

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
  /** How long a decrypted CONNECT waits for its client's first byte, in ms. For tests only. */
  firstByteTimeout?: number
  /**
   * The only requests a credential may be swapped into. A request a transformation matches that
   * isn't one of them gets a 403 from the gateway, not the placeholder sent upstream.
   */
  endpoints?: readonly EndpointMatch[]
  /** Called for each request refused under `endpoints`, e.g. to warn outside `REEVAL_DEBUG`. */
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
  /**
   * Requests whose response names the model that served them in its body (a `"model"` field, or
   * the `"modelId"` of an AI SDK stream's `response-metadata` part, and a `"reasoning"` object's
   * `"effort"`, as OpenAI's Responses API does): the gateway asks for it
   * uncompressed and records them as the request's `responseModel` and `responseEffort`. A
   * gateway's response may also name the upstream provider that served it (a `"provider"` string)
   * and what it charged (its last `"cost"` number), recorded as `responseProvider` and
   * `responseCost`.
   */
  modelResponses?: readonly EndpointMatch[]
  /**
   * Requests the gateway answers itself, never sending them upstream: e.g. a token exchange whose
   * answer is a placeholder the gateway then swaps for a real token on the model calls.
   */
  localResponses?: readonly LocalResponse[]
  /** Every DNS decision and, once each is done, every request and tunnel: for debug logs. */
  onEvent?: (event: EgressEvent) => void
}

type Headers = Record<string, string | string[]>

/** A request the gateway answers itself, with this status, these headers and this body. */
export type LocalResponse = {
  match: EndpointMatch
  status: number
  headers?: Record<string, string>
  body: string
}

/** One request through the gateway, or one tunnel it passed through without reading. */
export type EgressRequestEvent = {
  type: 'request'
  method: string
  /** `https://host/path` or `http://host:port/path`, without the query; `host:port` for a tunnel. */
  url: string
  host: string
  port: number
  /** `tunnel`: CONNECT passed through end to end; `decrypted`: read by the gateway; `http`: plain. */
  via: 'tunnel' | 'decrypted' | 'http'
  allowed: boolean
  status?: number
  /** Why it was refused. */
  reason?: string
  /** Body bytes from the sandbox and to it (a tunnel's are the connection's, TLS included). */
  sent: number
  received: number
  /** Brokered secrets swapped into the request, by name. */
  substituted: string[]
  /** Credential headers the gateway set (the harness's key), by name. */
  credentials: string[]
  ms: number
  /** As the sandbox sent them: placeholders, never real values. */
  requestHeaders?: Headers
  /** As the sandbox got them, scrubbed. */
  responseHeaders?: Headers
  /**
   * The reasoning settings the request body carried, on a `modelResponses` endpoint or a host
   * the gateway holds a harness credential or token for, as
   * `<path>=<value>` joined by spaces: `reasoning_effort=high`, or
   * `generationConfig.thinkingConfig.thinkingLevel=LOW`.
   */
  requestEffort?: string
  /** The model the response body says served it, on a `modelResponses` endpoint. */
  responseModel?: string
  /** The reasoning effort the response body says it ran at, on a `modelResponses` endpoint. */
  responseEffort?: string
  /** The upstream provider the response body says served it (OpenRouter's `"provider"`). */
  responseProvider?: string
  /** The last `"cost"` the response body names, in the gateway's credits (OpenRouter's US dollars). */
  responseCost?: number
}

export type EgressEvent =
  | { type: 'dns'; host: string; allowed: boolean; address?: string; reason?: string }
  | EgressRequestEvent

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
/** A host the gateway refused, and why: the policy, or a name that doesn't resolve. */
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

type RequestTracker = {
  refuse(reason: string): void
  set(
    fields: Partial<
      Pick<
        EgressRequestEvent,
        | 'substituted'
        | 'credentials'
        | 'responseHeaders'
        | 'status'
        | 'reason'
        | 'requestEffort'
        | 'responseModel'
        | 'responseEffort'
        | 'responseProvider'
        | 'responseCost'
      >
    >,
  ): void
  sent(bytes: number): void
  received(bytes: number): void
}
/** HTTP/1.1 and HTTP/2 compatibility responses share this surface. */
type Response = http.ServerResponse

/** A TLS record's first byte when it carries a handshake, as a ClientHello does. */
const TLS_HANDSHAKE = 0x16

/** How long a decrypted CONNECT waits for its client's first byte: Node's TLS handshake timeout. */
const FIRST_BYTE_TIMEOUT_MS = 120_000

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

/** Whether a parsed port names a TCP port; `net.connect` and `tls.connect` throw above 65535. */
const isPort = (port: number) => Number.isInteger(port) && port >= 1 && port <= 65535

/** `host` or `host:port` for a Host header or URL, IPv6 in brackets. */
const authorityOf = (host: string, port: number) => {
  const name = net.isIPv6(host) ? `[${host}]` : host
  return port === 443 ? name : `${name}:${port}`
}

const pathOnly = (path: string) => path.split('?')[0]

function reply(socket: Duplex, status: number, reason: string) {
  const text = http.STATUS_CODES[status] ?? ''
  socket.end(
    `HTTP/1.1 ${status} ${text}\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\n${reason}\n`,
  )
}

/** Counts the bytes passing through, without changing the flow. */
const counter = (count: (n: number) => void) =>
  new Transform({
    transform(chunk: Buffer, _encoding, done) {
      count(chunk.length)
      done(null, chunk)
    },
  })

/** The response encodings the gateway can decode to scrub a body. */
const DECODERS: Record<string, () => Transform> = {
  gzip: () => zlib.createGunzip(),
  'x-gzip': () => zlib.createGunzip(),
  deflate: () => zlib.createInflate(),
  br: () => zlib.createBrotliDecompress(),
}

/** Text a credential could be echoed into, or no type at all. */
const isText = (type: string) =>
  !type.trim() ||
  /^\s*(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|x-ndjson|[\w.-]+\+(json|xml))\b)/i.test(
    type,
  )

const plainHeaders = (headers: IncomingHttpHeaders | OutgoingHttpHeaders): Headers =>
  Object.fromEntries(
    Object.entries(headers).flatMap(([k, v]) =>
      v === undefined ? [] : [[k, Array.isArray(v) ? v.map(String) : String(v)]],
    ),
  )

export function createEgressProxy(options: EgressProxyOptions): EgressProxy {
  const log = options.log ?? (() => {})
  const firstByteTimeout = options.firstByteTimeout ?? FIRST_BYTE_TIMEOUT_MS
  const emit = (event: EgressEvent) => {
    try {
      options.onEvent?.(event)
    } catch {}
  }
  let rules: RequestTransformation[] = []
  let subs: Substitution[] = []
  /** Substitutions for derived tokens, added as their exchanges answer; kept by setSubstitutions. */
  let tokens: Substitution[] = []
  const allSubs = () => (tokens.length ? [...subs, ...tokens] : subs)
  const derived = options.derivedTokens ?? []
  const tokenHosts = derived.flatMap((d) => [d.endpoint.host, ...d.hosts])
  const locals = options.localResponses ?? []
  const localHosts = locals.map((l) => l.match.host)
  let policyCheck = createPolicyCheck(options.policy, options)
  const check = async (host: string) => {
    const verdict = await policyCheck(host)
    emit(
      verdict.allowed
        ? { type: 'dns', host, allowed: true, address: verdict.address }
        : { type: 'dns', host, allowed: false, reason: verdict.reason },
    )
    return verdict
  }
  /** Bytes each sandbox connection carried, both ways, for its tunnel's event. */
  const carried = new WeakMap<Duplex, { sent: number; received: number }>()
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
    const total = { sent: 0, received: 0 }
    carried.set(connection, total)
    const push = connection.push.bind(connection)
    connection.push = (chunk: unknown, encoding?: BufferEncoding) => {
      const entry = counting.get(connection)
      const n = chunk ? Buffer.byteLength(chunk as Buffer) : 0
      total.sent += n
      if (entry) entry.sent += n
      else unclaimed.set(connection, (unclaimed.get(connection) ?? 0) + n)
      return push(chunk, encoding)
    }
    const write = connection.write.bind(connection) as (...args: unknown[]) => boolean
    connection.write = ((chunk: unknown, ...rest: unknown[]) => {
      const entry = counting.get(connection)
      const n = chunk ? Buffer.byteLength(chunk as Buffer) : 0
      total.received += n
      if (entry) entry.received += n
      return write(chunk, ...rest)
    }) as Duplex['write']
  }
  const byHost = <T extends { host: string; port: number }>(entries: Iterable<T>) =>
    [...entries]
      .map((e) => ({ ...e }))
      .sort((a, b) => a.host.localeCompare(b.host) || a.port - b.port)

  /** Collects one request's event as it goes, and emits it when the response closes. */
  const requestEvent = (
    res: Response,
    base: Pick<EgressRequestEvent, 'method' | 'url' | 'host' | 'port' | 'via' | 'requestHeaders'>,
  ): RequestTracker => {
    const startedAt = Date.now()
    const event: EgressRequestEvent = {
      type: 'request',
      ...base,
      allowed: true,
      sent: 0,
      received: 0,
      substituted: [],
      credentials: [],
      ms: 0,
    }
    let emitted = false
    res.once('close', () => {
      if (emitted) return
      emitted = true
      emit({ ...event, status: event.status ?? res.statusCode, ms: Date.now() - startedAt })
    })
    return {
      refuse(reason) {
        event.allowed = false
        event.reason = reason
      },
      set(fields) {
        Object.assign(event, fields)
      },
      sent: (n) => {
        event.sent += n
      },
      received: (n) => {
        event.received += n
      },
    }
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
    if (!isPort(port)) {
      log(`reeval:egress CONNECT ${req.url} refused (invalid port)`)
      return reply(socket, 400, `reeval egress gateway: invalid port ${port} in CONNECT ${req.url}`)
    }
    const startedAt = Date.now()
    const tunnel = {
      type: 'request' as const,
      method: 'CONNECT',
      url: `${host}:${port}`,
      host,
      port,
      via: 'tunnel' as const,
      substituted: [],
      credentials: [],
      requestHeaders: plainHeaders(req.headers),
    }
    void check(host).then((verdict) => {
      if (!verdict.allowed) {
        log(`reeval:egress CONNECT ${host}:${port} denied (${verdict.reason})`)
        block(socket, host, port, verdict.reason)
        emit({
          ...tunnel,
          allowed: false,
          status: verdict.status,
          reason: verdict.reason,
          sent: 0,
          received: 0,
          ms: Date.now() - startedAt,
        })
        return reply(
          socket,
          verdict.status,
          `blocked by the reeval egress policy: ${verdict.reason}`,
        )
      }
      contact(socket, host, port)
      const target = { host, port, address: verdict.address }
      if (
        decrypts(rules, host) ||
        substitutes(allSubs(), host) ||
        hostAllowed(tokenHosts, host) ||
        hostAllowed(localHosts, host)
      ) {
        log(`reeval:egress CONNECT ${host}:${port} decrypt`)
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) socket.unshift(head)
        return firstByte(
          socket,
          (byte) =>
            byte === TLS_HANDSHAKE ? decrypt(socket, target) : plainInTunnel(socket, target),
          (reason) => {
            log(`reeval:egress CONNECT ${host}:${port} closed (${reason})`)
            emit({
              ...tunnel,
              allowed: true,
              reason,
              sent: 0,
              received: 0,
              ms: Date.now() - startedAt,
            })
          },
        )
      }
      log(`reeval:egress CONNECT ${host}:${port} tunnel`)
      let status = 200
      let reason: string | undefined
      const before = { ...(carried.get(socket) ?? { sent: 0, received: 0 }) }
      socket.once('close', () => {
        const after = carried.get(socket) ?? before
        emit({
          ...tunnel,
          allowed: true,
          status,
          ...(reason ? { reason } : {}),
          sent: after.sent - before.sent,
          received: after.received - before.received,
          ms: Date.now() - startedAt,
        })
      })
      const upstream = track(net.connect({ host: target.address, port, allowHalfOpen: true }))
      upstream.once('connect', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        link(socket, upstream)
      })
      upstream.once('error', (error) => {
        log(`reeval:egress CONNECT ${host}:${port} failed (${error.message})`)
        status = 502
        reason = `couldn't reach ${host}:${port}: ${error.message}`
        reply(socket, 502, `reeval egress gateway couldn't reach ${host}:${port}: ${error.message}`)
      })
    })
  })

  // Absolute-URL requests. An `https://` one is sent upstream over TLS by the gateway, as a
  // decrypted CONNECT request is, with the same policy, credentials and substitutions. A plain
  // `http://` one is never given credentials or substitutions, so a placeholder sent over plain
  // HTTP goes out as the placeholder.
  front.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
    let url: URL
    try {
      url = new URL(req.url ?? '')
    } catch {
      return res.writeHead(400).end('reeval egress gateway: expected an absolute URL\n')
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      return res
        .writeHead(400)
        .end(`reeval egress gateway: expected an http:// or https:// URL, not ${url.protocol}\n`)
    const secure = url.protocol === 'https:'
    const { host, port } = parseAuthority(url.host, secure ? 443 : 80)
    if (!isPort(port)) {
      log(`reeval:egress ${req.method} ${url.protocol}//${url.host} refused (invalid port)`)
      return res
        .writeHead(400)
        .end(`reeval egress gateway: invalid port ${port} in ${url.origin}\n`)
    }
    const shown = secure ? `https://${host}` : `http://${host}:${port}`
    const done = requestEvent(res, {
      method: req.method ?? 'GET',
      url: `${shown}${url.pathname}`,
      host,
      port,
      via: secure ? 'decrypted' : 'http',
      requestHeaders: plainHeaders(req.headers),
    })
    const path = url.pathname + url.search
    void check(host).then((verdict) => {
      if (!verdict.allowed) {
        log(`reeval:egress ${req.method} ${shown} denied (${verdict.reason})`)
        block(req.socket, host, port, verdict.reason)
        done.refuse(verdict.reason)
        return res
          .writeHead(verdict.status)
          .end(`blocked by the reeval egress policy: ${verdict.reason}\n`)
      }
      contact(req.socket, host, port)
      const target = { host, port, address: verdict.address }
      if (secure) {
        // The request line's authority wins over Host (RFC 9112 §3.2.2): clients send the proxy's.
        const headers = { ...req.headers, host: url.host }
        return void onDecrypted(target, req, res, path, headers, done)
      }
      onPlain(target, req, res, path, url.host, done)
    })
  })
  front.on('upgrade', (_req: http.IncomingMessage, socket: Duplex) => {
    reply(socket, 501, 'reeval egress gateway: use CONNECT for websockets')
  })

  /**
   * Sends a plain-HTTP request upstream as the sandbox sent it: never given credentials or
   * substitutions, so a placeholder sent over plain HTTP goes out as the placeholder.
   */
  function onPlain(
    target: Target,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    path: string,
    host: string,
    done: RequestTracker,
  ) {
    const url = `http://${target.host}:${target.port}${pathOnly(path)}`
    log(`reeval:egress ${req.method} ${url}`)
    const upstream = http.request({
      host: target.address,
      port: target.port,
      method: req.method,
      path,
      headers: { ...endToEnd(req.headers), host },
    })
    forwardHttp1(req.pipe(counter(done.sent)), res, upstream, { own: [], creds: [], url, t: done })
  }

  /**
   * Calls `then` with the connection's first byte once it arrives, left unread for the next
   * reader, or `idle` with why there's none: the client closed it first, or it waited
   * `firstByteTimeout` and closed it.
   */
  function firstByte(socket: Duplex, then: (byte: number) => void, idle: (why: string) => void) {
    const timer = setTimeout(() => {
      stop()
      socket.destroy()
      idle(`the client sent nothing within ${firstByteTimeout / 1000}s`)
    }, firstByteTimeout)
    const onReadable = () => {
      const chunk = socket.read() as Buffer | null
      if (!chunk?.length) return
      stop()
      socket.unshift(chunk)
      then(chunk[0] as number)
    }
    const onClose = () => {
      stop()
      idle('the client closed the connection without sending anything')
    }
    const stop = () => {
      clearTimeout(timer)
      socket.off('readable', onReadable)
      socket.off('close', onClose)
    }
    socket.on('readable', onReadable)
    socket.once('close', onClose)
  }

  /**
   * The path a request in a plain tunnel asks for, or why it's refused: its Host or absolute-form
   * URL names a host other than the CONNECT target, which a server sharing the target's address
   * could route it to.
   */
  function inTunnel(target: Target, req: http.IncomingMessage): { path: string; refused?: string } {
    const asked = req.url ?? '/'
    const absolute = asked.startsWith('/') ? undefined : URL.parse(asked)
    const path = absolute ? absolute.pathname + absolute.search : asked
    for (const named of [absolute?.host, req.headers.host]) {
      if (!named) continue
      const host = parseAuthority(named, target.port).host
      if (host === target.host) continue
      const shown = `http://${authorityOf(target.host, target.port)}${pathOnly(path)}`
      log(`reeval:egress ${req.method} ${shown} refused (Host ${host})`)
      return {
        path,
        refused: `reeval egress gateway: the request names ${host}, but the connection is to ${target.host}; send it on a connection to ${host}.`,
      }
    }
    return { path }
  }

  /**
   * Serves a CONNECT to a decrypted host whose client speaks plain HTTP/1.1 in the tunnel, as a
   * Node client sends an `http://` request through a proxy: each request goes upstream as an
   * absolute-form `http://` one does, with no credentials or substitutions.
   */
  function plainInTunnel(socket: Duplex, target: Target) {
    const authority = authorityOf(target.host, target.port)
    const refuse = (s: Duplex, reason: string) => {
      emit({
        type: 'request',
        method: 'CONNECT',
        url: authority,
        host: target.host,
        port: target.port,
        via: 'http',
        allowed: false,
        status: 400,
        reason,
        sent: 0,
        received: 0,
        substituted: [],
        credentials: [],
        ms: 0,
      })
      reply(s, 400, reason)
    }
    const server = http.createServer((req, res) => {
      const { path, refused } = inTunnel(target, req)
      const done = requestEvent(res, {
        method: req.method ?? 'GET',
        url: `http://${authority}${pathOnly(path)}`,
        host: target.host,
        port: target.port,
        via: 'http',
        requestHeaders: plainHeaders(req.headers),
      })
      if (refused) {
        done.refuse(refused)
        req.resume()
        return res.writeHead(421, { 'content-type': 'text/plain' }).end(`${refused}\n`)
      }
      onPlain(target, req, res, path, req.headers.host ?? authority, done)
    })
    server.on('upgrade', (req: http.IncomingMessage, s: Duplex, head: Buffer) =>
      onPlainUpgrade(target, req, track(s), head),
    )
    server.on('connect', (req: http.IncomingMessage, s: Duplex) => {
      log(`reeval:egress CONNECT ${authority} refused (CONNECT ${req.url} inside it)`)
      refuse(
        s,
        `reeval egress gateway: CONNECT ${req.url} came inside the tunnel to ${authority}; send it to the gateway on a connection of its own.`,
      )
    })
    server.on('clientError', (error: NodeJS.ErrnoException, s: Duplex) => {
      // Node reports the socket's own errors (a reset) and a client hanging up mid-request here
      // too; only a parse error is the client's.
      if (!error.code?.startsWith('HPE_') || error.code === 'HPE_INVALID_EOF_STATE') {
        return s.destroy()
      }
      log(`reeval:egress CONNECT ${authority} refused (neither TLS nor HTTP/1.1)`)
      refuse(
        s,
        `reeval egress gateway: the connection to ${authority} carries neither a TLS handshake nor an HTTP/1.1 request. reeval reads every connection to a host with a brokered secret.`,
      )
    })
    server.emit('connection', socket)
  }

  /** A plain-HTTP upgrade (a `ws://` WebSocket) in a tunnel, passed upstream as it is. */
  function onPlainUpgrade(target: Target, req: http.IncomingMessage, socket: Duplex, head: Buffer) {
    const method = req.method ?? 'GET'
    const startedAt = Date.now()
    const authority = authorityOf(target.host, target.port)
    const { path, refused } = inTunnel(target, req)
    const upgraded = (fields: Partial<EgressRequestEvent>) =>
      emit({
        type: 'request',
        method,
        url: `http://${authority}${pathOnly(path)}`,
        host: target.host,
        port: target.port,
        via: 'http',
        allowed: true,
        sent: 0,
        received: 0,
        substituted: [],
        credentials: [],
        requestHeaders: plainHeaders(req.headers),
        ...fields,
        ms: Date.now() - startedAt,
      })
    if (refused) {
      upgraded({ allowed: false, status: 421, reason: refused })
      return reply(socket, 421, refused)
    }
    log(`reeval:egress ${method} http://${authority}${pathOnly(path)} (upgrade)`)
    const upstream = http.request({
      host: target.address,
      port: target.port,
      method,
      path,
      headers: {
        ...endToEnd(req.headers, ['upgrade', 'connection']),
        host: req.headers.host ?? authority,
      },
    })
    upstream.once('upgrade', (up, upSocket: Duplex, upHead: Buffer) => {
      upgraded({ status: up.statusCode, responseHeaders: plainHeaders(up.headers) })
      const lines = [`HTTP/1.1 ${up.statusCode} ${up.statusMessage}`]
      for (let i = 0; i < up.rawHeaders.length; i += 2) {
        lines.push(`${up.rawHeaders[i]}: ${up.rawHeaders[i + 1] ?? ''}`)
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head.length) upSocket.write(head)
      if (upHead.length) socket.write(upHead)
      link(socket, track(upSocket))
    })
    upstream.once('response', (up) => {
      upgraded({ status: up.statusCode })
      reply(socket, up.statusCode ?? 502, `upstream refused the upgrade (${up.statusCode})`)
      up.resume()
    })
    upstream.once('error', (error) => {
      upgraded({ status: 502, reason: error.message })
      reply(socket, 502, `reeval egress gateway: ${error.message}`)
    })
    upstream.end()
  }

  /**
   * Terminates TLS with a certificate for the CONNECT host. One server per connection, since the
   * host comes from CONNECT; it serves HTTP/2 and HTTP/1.1 (with upgrades) by ALPN.
   */
  function decrypt(socket: Duplex, target: Target) {
    const server = http2.createSecureServer(
      { ...credentialsFor(target.host), allowHTTP1: true },
      // HTTP/2's compatibility response takes the same calls; only its overload types differ.
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
    /** Brokered secrets substituted, and credential headers set, by name. */
    names: string[]
    credentials: string[]
    refused?: { status: number; reason: string }
    /** Set when this is a token exchange, whose response gets placeholders for its tokens. */
    exchange?: DerivedTokens
    /** Whether its response names the model that served it. */
    readsModel?: boolean
  } {
    // An absolute-form target names its own host, which the upstream honors over Host.
    if (!path.startsWith('/') && !(method === 'OPTIONS' && path === '*')) {
      const reason = `reeval egress gateway: expected a path in the request line on a connection to ${target.host}, not an absolute URL.`
      log(`reeval:egress ${method} https://${target.host} refused (absolute-form target)`)
      return {
        headers: {},
        path,
        own: [],
        names: [],
        credentials: [],
        refused: { status: 400, reason },
      }
    }
    const named = String(headers[':authority'] ?? headers.host ?? '')
    const asked = parseAuthority(named, target.port).host
    if (named && asked !== target.host) {
      const reason = `reeval egress gateway: the request names ${asked}, but the connection is to ${target.host}; send it on a connection to ${asked}.`
      log(`reeval:egress ${method} https://${target.host}${pathOnly(path)} refused (Host ${asked})`)
      return {
        headers: {},
        path,
        own: [],
        names: [],
        credentials: [],
        refused: { status: 421, reason },
      }
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
      log(`reeval:egress ${method} ${url} HTTP/${version} refused (not a brokered endpoint)`)
      options.onRefused?.({ method, url })
      return {
        headers: {},
        path,
        own: [],
        names: [],
        credentials: [],
        refused: {
          status: 403,
          reason: `reeval egress gateway: refused ${method} ${url}. It carries a brokered credential, and it isn't one of the endpoints reeval brokers it for.`,
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
    const readsModel = onEndpoint(options.modelResponses ?? [], {
      host: target.host,
      method,
      path,
      headers: {},
    })
    // Uncompressed responses, so the scrubber, the tokenizer and the model reader see them.
    if (
      scrubbedInBodies(own).length ||
      credentialValues(rules, target.host).length ||
      exchange ||
      readsModel
    ) {
      delete substituted.headers['accept-encoding']
    }
    const notes = [
      replaced.length ? `set ${replaced.join(', ')}` : '',
      substituted.names.length ? `substituted ${substituted.names.join(', ')}` : '',
      ...kept.map((k) => `kept ${k.name}'s placeholder in the ${k.where}`),
    ].filter(Boolean)
    log(
      `reeval:egress ${method} ${url} HTTP/${version}${notes.length ? ` (${notes.join('; ')})` : ''}`,
    )
    return {
      headers: substituted.headers as OutgoingHttpHeaders,
      path: substituted.path,
      own,
      names: substituted.names,
      credentials: replaced,
      ...(exchange ? { exchange } : {}),
      ...(readsModel ? { readsModel } : {}),
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
    t?: RequestTracker,
    readsEffort = false,
  ): Readable | Transform {
    const encoded = String(headers['content-encoding'] ?? 'identity') !== 'identity'
    const sent = t ? req.pipe(counter(t.sent)) : req
    const counted = readsEffort && t && !encoded ? sent.pipe(effortReader(t)) : sent
    if (encoded || !own.some((s) => s.in.includes('body'))) return counted
    delete headers['content-length']
    return counted.pipe(bodySubstituter(own))
  }

  const scrubs = options.scrubResponses !== false

  /**
   * The harness credentials the rules set on `host`, shaped as substitutions that are never
   * swapped in, only scrubbed from responses.
   */
  const credentialScrubs = (host: string): Substitution[] =>
    credentialValues(rules, host).map(([value, shown]) => ({
      name: 'credential',
      placeholder: shown,
      value,
      hosts: [host],
      in: [],
    }))

  /**
   * How a response's body is scrubbed: the values to put back as placeholders, and the encoding
   * to decode first. The harness's credentials are scrubbed from text and from any response that
   * isn't a success, never from a binary stream such as gRPC, where holding back a byte that
   * might start one could stall a bidirectional call. `refuse` when the body can't be read.
   */
  type ScrubPlan = { body: Substitution[]; decode?: string; refuse?: string }
  function scrubPlan(
    status: number,
    headers: IncomingHttpHeaders,
    own: Substitution[],
    creds: Substitution[],
  ): ScrubPlan {
    if (!scrubs || status === 204 || status === 304) return { body: [] }
    const type = String(headers['content-type'] ?? '')
    const body = [...scrubbedInBodies(own), ...(status >= 300 || isText(type) ? creds : [])]
    const encoding = String(headers['content-encoding'] ?? 'identity').toLowerCase()
    if (!body.length || encoding === 'identity') return { body }
    if (encoding in DECODERS) return { body, decode: encoding }
    return { body, refuse: `the response is ${encoding}-encoded, so it can't be scrubbed` }
  }

  /**
   * The response body as sent to the sandbox: decoded if the plan says so, with real values put
   * back as placeholders. An error anywhere upstream of it (a corrupt encoding) errors it.
   */
  function responseBody(
    up: Readable,
    plan: ScrubPlan,
    t?: RequestTracker,
    readsModel = false,
  ): Readable {
    if (readsModel && t) readModel(up, t)
    const into = (from: Readable, to: Transform) => {
      from.once('error', (error) => to.destroy(error))
      return from.pipe(to)
    }
    let body = up
    const decoder = plan.decode ? DECODERS[plan.decode] : undefined
    if (decoder) body = into(body, decoder())
    if (plan.body.length) body = into(body, scrubber(plan.body))
    return t ? into(body, counter(t.received)) : body
  }

  /** Header (and trailer) values with every real value put back as its placeholder. */
  const scrubbedHeaders = (headers: IncomingHttpHeaders, all: Substitution[]) => {
    const out = endToEnd(headers)
    if (!all.length || !scrubs) return out
    return scrubHeaders(all, out as Record<string, string>) as OutgoingHttpHeaders
  }

  const responseHeaders = (
    headers: IncomingHttpHeaders,
    own: Substitution[],
    creds: Substitution[],
    plan: ScrubPlan,
  ) => {
    const out = scrubbedHeaders(headers, [...own, ...creds])
    if (plan.body.length) delete out['content-length']
    if (plan.decode) delete out['content-encoding']
    return out
  }

  /** Answers a response the gateway won't pass on with a 502 saying why. */
  function refuseResponse(
    res: Response,
    up: Readable,
    url: string,
    why: string,
    t?: RequestTracker,
  ) {
    log(`reeval:egress ${url} response refused (${why})`)
    up.resume()
    t?.set({ status: 502, reason: why })
    if (res.headersSent) return res.destroy()
    res.writeHead(502, { 'content-type': 'text/plain' }).end(`reeval egress gateway: ${why}\n`)
  }

  /**
   * How far into a response the gateway looks for the model that served it: OpenAI's first event
   * echoes the request's instructions and tools before it.
   */
  const MODEL_WINDOW = 512 * 1024

  /**
   * How much of a response's end the gateway keeps to find its last `"cost"`, and the routing
   * metadata a Responses API stream repeats in its last event.
   */
  const TAIL = 16 * 1024

  const PROVIDER = /"provider"\s*:\s*"([^"\\]{1,200})"/
  /**
   * The provider of the endpoint a gateway's routing metadata marks `"selected": true`
   * (OpenRouter's `openrouter_metadata.endpoints.available`, which lists the others too).
   */
  const selectedProvider = (text: string) => {
    const endpoint = /\{[^{}]*"selected"\s*:\s*true[^{}]*\}/.exec(text)
    return endpoint ? PROVIDER.exec(endpoint[0])?.[1] : undefined
  }

  /**
   * Records the first `"model"` or `"modelId"` value in the response body and the `"effort"` of the
   * `"reasoning"` object after it, within {@link MODEL_WINDOW}; the provider of a selected endpoint
   * there or in the body's {@link TAIL}, else the first `"provider"` string in the window; and the
   * last `"cost"` number in the whole body, reading alongside its flow. Inside a JSON string the
   * quotes are escaped, so text that merely mentions them doesn't match.
   */
  function readModel(up: Readable, t: RequestTracker) {
    let seen = ''
    let tail = ''
    let model: RegExpExecArray | null = null
    let effort: RegExpExecArray | null = null
    let provider: string | undefined
    let selected: string | undefined
    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      if (seen.length <= MODEL_WINDOW && !(effort && selected)) {
        seen += text
        model ??= /"model(?:Id)?"\s*:\s*"([^"\\]{1,200})"/.exec(seen)
        effort ??= model
          ? /"reasoning"\s*:\s*\{[^{}]*?"effort"\s*:\s*"(\w{1,40})"/.exec(seen.slice(model.index))
          : null
        provider ??= PROVIDER.exec(seen)?.[1]
        selected ??= selectedProvider(seen)
        if (model) t.set({ responseModel: model[1] })
        if (effort) t.set({ responseEffort: effort[1] })
      }
      tail = (tail + text).slice(-TAIL)
      selected ??= selectedProvider(tail)
      const served = selected ?? provider
      if (served) t.set({ responseProvider: served })
      const cost = [...tail.matchAll(/"cost"\s*:\s*(\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/g)].at(-1)
      if (cost) t.set({ responseCost: Number(cost[1]) })
    }
    up.on('data', onData)
  }

  /** Most of a request body the gateway reads for its reasoning settings: a long session's. */
  const EFFORT_LIMIT = 16 * 1024 * 1024

  /**
   * The body passed on as it flows, recording the reasoning settings its JSON carries once it
   * ends. A transform, not a `data` listener: that would start the body flowing before the
   * upstream request is there to take it.
   */
  function effortReader(t: RequestTracker): Transform {
    const chunks: Buffer[] = []
    let size = 0
    return new Transform({
      transform(chunk: Buffer, _encoding, done) {
        size += chunk.length
        if (size <= EFFORT_LIMIT) chunks.push(chunk)
        done(null, chunk)
      },
      flush(done) {
        if (size <= EFFORT_LIMIT) {
          const effort = requestedEffort(Buffer.concat(chunks).toString('utf8'))
          if (effort) t.set({ requestEffort: effort })
        }
        done()
      },
    })
  }

  /** Most an exchange's response may be; it's a few hundred bytes of JSON. */
  const EXCHANGE_LIMIT = 1 << 20

  /**
   * A token exchange's response, read whole, with each token replaced by a placeholder. A success
   * that can't be read (compressed, too big, not JSON) is a 502: the real tokens never go through.
   */
  function tokenized(
    exchange: DerivedTokens,
    url: string,
    status: number,
    headers: IncomingHttpHeaders,
    up: Readable,
    res: Response,
    own: Substitution[],
    creds: Substitution[],
    t?: RequestTracker,
  ) {
    const chunks: Buffer[] = []
    let size = 0
    const refuse = (why: string) => {
      log(`reeval:egress ${url} response refused (${why})`)
      if (!res.headersSent) {
        res
          .writeHead(502, { 'content-type': 'text/plain' })
          .end(`reeval egress gateway: couldn't keep ${exchange.name}'s tokens out of the sandbox: ${why}
`)
      } else res.destroy()
    }
    const plan = scrubPlan(status, headers, own, creds)
    if (plan.refuse) {
      up.resume()
      return refuse(plan.refuse)
    }
    const scrubbed = responseBody(up, plan, t)
    scrubbed.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size <= EXCHANGE_LIMIT) chunks.push(chunk)
    })
    scrubbed.once('error', (error) => refuse(error.message))
    scrubbed.once('end', () => {
      const body = Buffer.concat(chunks)
      const out = responseHeaders(headers, own, creds, plan)
      t?.set({ responseHeaders: plainHeaders(out) })
      if (status < 200 || status >= 300) return res.writeHead(status, out).end(body)
      // Fails closed even when decoded: the tokenizer reads only what the upstream sent as is.
      const encoding = String(headers['content-encoding'] ?? 'identity')
      if (encoding !== 'identity') return refuse(`the response is ${encoding}-encoded`)
      if (size > EXCHANGE_LIMIT) return refuse(`the response is over ${EXCHANGE_LIMIT} bytes`)
      let result: ReturnType<typeof tokenizeResponse>
      try {
        result = tokenizeResponse(exchange, body.toString('utf8'), tokens)
      } catch (error) {
        return refuse((error as Error).message)
      }
      tokens = [...tokens, ...result.added]
      log(
        `reeval:egress ${url} tokenized ${result.fields.join(', ') || 'nothing'} (${exchange.name})`,
      )
      const text = Buffer.from(result.body)
      delete out['content-encoding']
      res.writeHead(status, { ...out, 'content-length': String(text.length) }).end(text)
    })
  }

  async function onDecrypted(
    target: Target,
    req: http.IncomingMessage | http2.Http2ServerRequest,
    res: Response,
    asked = req.url ?? '/',
    sent: IncomingHttpHeaders = req.headers,
    tracker?: RequestTracker,
  ) {
    const method = req.method ?? 'GET'
    const url = `https://${target.host}${pathOnly(asked)}`
    const t =
      tracker ??
      requestEvent(res, {
        method,
        url,
        host: target.host,
        port: target.port,
        via: 'decrypted',
        requestHeaders: plainHeaders(req.headers),
      })
    const { headers, path, own, names, credentials, refused, exchange, readsModel } = transformed(
      target,
      method,
      asked,
      sent,
      req.httpVersion,
    )
    t.set({ substituted: names, credentials })
    if (refused) {
      t.refuse(refused.reason)
      req.resume()
      return res
        .writeHead(refused.status, { 'content-type': 'text/plain' })
        .end(`${refused.reason}\n`)
    }
    const local = locals.find((l) =>
      onEndpoint([l.match], { host: target.host, method, path: asked, headers: {} }),
    )
    if (local) {
      log(`reeval:egress ${method} ${url} answered by the gateway (${local.status})`)
      req.resume()
      const out = { 'content-type': 'application/json', ...local.headers }
      t.set({ status: local.status, responseHeaders: out })
      return res.writeHead(local.status, out).end(local.body)
    }
    delete headers.upgrade
    delete headers.connection
    const readsEffort =
      !!readsModel ||
      setsCredential(rules, target.host) ||
      substitutes(allSubs(), target.host) ||
      hostAllowed(tokenHosts, target.host)
    const body = requestBody(req as Readable, headers, own, t, readsEffort)
    const authority = authorityOf(target.host, target.port)
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
      return forwardHttp1(body, res, upstream, {
        own,
        creds: credentialScrubs(target.host),
        url,
        ...(exchange ? { exchange } : {}),
        ...(t ? { t } : {}),
        readsModel: !!readsModel,
      })
    }
    const stream = session.request({
      ...headers,
      ':method': method,
      ':path': path,
      ':scheme': 'https',
      ':authority': authority,
    })
    const fail = (error: Error) => {
      if (!res.headersSent) res.writeHead(502).end(`reeval egress gateway: ${error.message}\n`)
      else res.destroy()
    }
    stream.once('error', fail)
    const creds = credentialScrubs(target.host)
    stream.once('response', (h) => {
      const status = Number(h[':status'])
      if (exchange) return tokenized(exchange, url, status, h, stream, res, own, creds, t)
      if (!respond(status, h, stream, res, own, creds, url, t, readsModel)) return
      stream.once('trailers', (trailers) =>
        res.addTrailers(scrubbedHeaders(trailers, [...own, ...creds]) as Record<string, string>),
      )
    })
    body.pipe(stream)
    req.once('aborted', () => stream.close(http2.constants.NGHTTP2_CANCEL))
  }

  /**
   * Sends an upstream response on to the sandbox, scrubbed. False when it was refused instead,
   * already answered with a 502.
   */
  function respond(
    status: number,
    headers: IncomingHttpHeaders,
    up: Readable,
    res: Response,
    own: Substitution[],
    creds: Substitution[],
    url: string,
    t?: RequestTracker,
    readsModel = false,
  ): boolean {
    const plan = scrubPlan(status, headers, own, creds)
    if (plan.refuse) {
      refuseResponse(res, up, url, plan.refuse, t)
      return false
    }
    const out = responseHeaders(headers, own, creds, plan)
    t?.set({ responseHeaders: plainHeaders(out) })
    res.writeHead(status, out)
    responseBody(up, plan, t, readsModel)
      .once('error', () => res.destroy())
      .pipe(res)
    return true
  }

  function forwardHttp1(
    req: Readable,
    res: Response,
    upstream: http.ClientRequest,
    to: {
      own: Substitution[]
      creds: Substitution[]
      url: string
      exchange?: DerivedTokens
      t?: RequestTracker
      readsModel?: boolean
    },
  ) {
    const { own, creds, url, exchange, t } = to
    upstream.once('response', (up) => {
      const status = up.statusCode ?? 502
      if (exchange) return tokenized(exchange, url, status, up.headers, up, res, own, creds, t)
      if (!respond(status, up.headers, up, res, own, creds, url, t, to.readsModel)) return
      up.once('end', () => {
        if (Object.keys(up.trailers).length) {
          res.addTrailers(
            scrubbedHeaders(up.trailers, [...own, ...creds]) as Record<string, string>,
          )
        }
      })
    })
    upstream.once('error', (error) => {
      t?.set({ status: 502, reason: error.message })
      if (!res.headersSent) res.writeHead(502).end(`reeval egress gateway: ${error.message}\n`)
      else res.destroy()
    })
    req.pipe(upstream)
  }

  function onUpgrade(target: Target, req: http.IncomingMessage, socket: Duplex, head: Buffer) {
    const method = req.method ?? 'GET'
    const startedAt = Date.now()
    const { headers, path, own, names, credentials, refused } = transformed(
      target,
      method,
      req.url ?? '/',
      req.headers,
      req.httpVersion,
    )
    const all = scrubs ? [...own, ...credentialScrubs(target.host)] : []
    const scrubbed = (value: string) => scrubValue(all, value)
    // Uncompressed frames, so the scrubber can read them.
    if (all.length) delete headers['sec-websocket-extensions']
    const upgraded = (fields: Partial<EgressRequestEvent>) =>
      emit({
        type: 'request',
        method,
        url: `https://${target.host}${pathOnly(req.url ?? '/')}`,
        host: target.host,
        port: target.port,
        via: 'decrypted',
        allowed: true,
        sent: 0,
        received: 0,
        substituted: names,
        credentials,
        requestHeaders: plainHeaders(req.headers),
        ...fields,
        ms: Date.now() - startedAt,
      })
    if (refused) {
      upgraded({ allowed: false, status: refused.status, reason: refused.reason })
      return reply(socket, refused.status, refused.reason)
    }
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
      const out = scrubHeaders(all, up.headers)
      upgraded({ status: up.statusCode, responseHeaders: plainHeaders(out) })
      const lines = [`HTTP/1.1 ${up.statusCode} ${up.statusMessage}`]
      for (let i = 0; i < up.rawHeaders.length; i += 2) {
        lines.push(`${up.rawHeaders[i]}: ${scrubbed(up.rawHeaders[i + 1] ?? '')}`)
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head.length) upSocket.write(head)
      track(upSocket)
      if (!all.length) {
        if (upHead.length) socket.write(upHead)
        return link(socket, upSocket)
      }
      const frames = webSocketScrubber(all)
      if (upHead.length) frames.write(upHead)
      upSocket.pipe(frames)
      upSocket.once('error', (error) => frames.destroy(error))
      link(socket, Duplex.from({ readable: frames, writable: upSocket }))
    })
    upstream.once('response', (up) => {
      reply(socket, up.statusCode ?? 502, `upstream refused the upgrade (${up.statusCode})`)
      up.resume()
    })
    upstream.once('error', (error) => reply(socket, 502, `reeval egress gateway: ${error.message}`))
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
        const session = http2.connect(`https://${authorityOf(target.host, target.port)}`, {
          createConnection: () => socket,
        })
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
      policyCheck = createPolicyCheck(policy, options)
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
