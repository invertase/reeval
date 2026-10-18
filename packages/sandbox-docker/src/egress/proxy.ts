import http, { type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'node:http'
import http2 from 'node:http2'
import https from 'node:https'
import net from 'node:net'
import { type Duplex, type Readable, Transform } from 'node:stream'
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
  scrubValue,
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
   * Requests whose response names the model that served them in its body (a `"model"` field, and
   * a `"reasoning"` object's `"effort"`, as OpenAI's Responses API does): the gateway asks for it
   * uncompressed and records them as the request's `responseModel` and `responseEffort`.
   */
  modelResponses?: readonly EndpointMatch[]
  /** Every DNS decision and, once each is done, every request and tunnel: for debug logs. */
  onEvent?: (event: EgressEvent) => void
}

type Headers = Record<string, string | string[]>

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
  /** The model the response body says served it, on a `modelResponses` endpoint. */
  responseModel?: string
  /** The reasoning effort the response body says it ran at, on a `modelResponses` endpoint. */
  responseEffort?: string
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
        | 'responseModel'
        | 'responseEffort'
      >
    >,
  ): void
  sent(bytes: number): void
  received(bytes: number): void
}
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

/** Counts the bytes passing through, without changing the flow. */
const counter = (count: (n: number) => void) =>
  new Transform({
    transform(chunk: Buffer, _encoding, done) {
      count(chunk.length)
      done(null, chunk)
    },
  })

const plainHeaders = (headers: IncomingHttpHeaders | OutgoingHttpHeaders): Headers =>
  Object.fromEntries(
    Object.entries(headers).flatMap(([k, v]) =>
      v === undefined ? [] : [[k, Array.isArray(v) ? v.map(String) : String(v)]],
    ),
  )

export function createEgressProxy(options: EgressProxyOptions): EgressProxy {
  const log = options.log ?? (() => {})
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
      if (decrypts(rules, host) || substitutes(allSubs(), host) || hostAllowed(tokenHosts, host)) {
        log(`reeval:egress CONNECT ${host}:${port} decrypt`)
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) socket.unshift(head)
        return decrypt(socket, target)
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

  // Absolute-URL requests: plain HTTP through the proxy. Never given credentials or substitutions,
  // so a placeholder sent over plain HTTP goes out as the placeholder.
  front.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
    let url: URL
    try {
      url = new URL(req.url ?? '')
    } catch {
      return res.writeHead(400).end('reeval egress gateway: expected an absolute URL\n')
    }
    if (url.protocol !== 'http:')
      return res.writeHead(400).end('reeval egress gateway: http only\n')
    const { host, port } = parseAuthority(url.host, 80)
    const done = requestEvent(res, {
      method: req.method ?? 'GET',
      url: `http://${host}:${port}${url.pathname}`,
      host,
      port,
      via: 'http',
      requestHeaders: plainHeaders(req.headers),
    })
    void check(host).then((verdict) => {
      if (!verdict.allowed) {
        log(`reeval:egress ${req.method} http://${host}:${port} denied (${verdict.reason})`)
        block(req.socket, host, port, verdict.reason)
        done.refuse(verdict.reason)
        return res
          .writeHead(verdict.status)
          .end(`blocked by the reeval egress policy: ${verdict.reason}\n`)
      }
      log(`reeval:egress ${req.method} http://${host}:${port}${url.pathname}`)
      contact(req.socket, host, port)
      const upstream = http.request({
        host: verdict.address,
        port,
        method: req.method,
        path: url.pathname + url.search,
        headers: { ...endToEnd(req.headers), host: url.host },
      })
      forwardHttp1(req.pipe(counter(done.sent)), res, upstream, [], undefined, done)
    })
  })
  front.on('upgrade', (_req: http.IncomingMessage, socket: Duplex) => {
    reply(socket, 501, 'reeval egress gateway: use CONNECT for websockets')
  })

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
    // Uncompressed responses, so the scrubber, the tokeniser and the model reader see them.
    if (scrubbedInBodies(own).length || exchange || readsModel) {
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
  ): Readable | Transform {
    const counted = t ? req.pipe(counter(t.sent)) : req
    const encoded = String(headers['content-encoding'] ?? 'identity') !== 'identity'
    if (encoded || !own.some((s) => s.in.includes('body'))) return counted
    delete headers['content-length']
    return counted.pipe(bodySubstituter(own))
  }

  /** The response body as sent to the sandbox: real values put back as placeholders. */
  const scrubs = options.scrubResponses !== false
  function responseBody(
    up: Readable,
    own: Substitution[],
    t?: RequestTracker,
    readsModel = false,
  ): Readable | Transform {
    if (readsModel && t) readModel(up, t)
    const body = scrubbedInBodies(own).length && scrubs ? up.pipe(scrubber(own)) : up
    return t ? body.pipe(counter(t.received)) : body
  }

  const responseHeaders = (headers: IncomingHttpHeaders, own: Substitution[]) => {
    const out = endToEnd(headers)
    if (!own.length || !scrubs) return out
    if (scrubbedInBodies(own).length) delete out['content-length']
    return scrubHeaders(own, out as Record<string, string>) as OutgoingHttpHeaders
  }

  /**
   * How far into a response the gateway looks for the model that served it: OpenAI's first event
   * echoes the request's instructions and tools before it.
   */
  const MODEL_WINDOW = 512 * 1024

  /**
   * Records the first `"model"` value in the response body, and the `"effort"` of the
   * `"reasoning"` object after it, reading alongside its flow. Inside a JSON string the quotes are
   * escaped, so text that merely mentions them doesn't match.
   */
  function readModel(up: Readable, t: RequestTracker) {
    let seen = ''
    const onData = (chunk: Buffer) => {
      seen += chunk.toString('utf8')
      const model = /"model"\s*:\s*"([^"\\]{1,200})"/.exec(seen)
      const effort = model
        ? /"reasoning"\s*:\s*\{[^{}]*?"effort"\s*:\s*"(\w{1,40})"/.exec(seen.slice(model.index))
        : null
      if (model) t.set({ responseModel: model[1] })
      if (effort) t.set({ responseEffort: effort[1] })
      if (effort || seen.length > MODEL_WINDOW) up.off('data', onData)
    }
    up.on('data', onData)
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
    const scrubbed = responseBody(up, own, t)
    scrubbed.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size <= EXCHANGE_LIMIT) chunks.push(chunk)
    })
    up.once('error', (error) => refuse(error.message))
    scrubbed.once('end', () => {
      const body = Buffer.concat(chunks)
      const out = responseHeaders(headers, own)
      t?.set({ responseHeaders: plainHeaders(out) })
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
      log(
        `reeval:egress ${url} tokenised ${result.fields.join(', ') || 'nothing'} (${exchange.name})`,
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
  ) {
    const method = req.method ?? 'GET'
    const url = `https://${target.host}${pathOnly(req.url ?? '/')}`
    const t = requestEvent(res, {
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
      req.url ?? '/',
      req.headers,
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
    delete headers.upgrade
    delete headers.connection
    const body = requestBody(req as Readable, headers, own, t)
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
      return forwardHttp1(body, res, upstream, own, exchange && { exchange, url }, t, readsModel)
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
    stream.once('response', (h) => {
      if (exchange) return tokenised(exchange, url, Number(h[':status']), h, stream, res, own, t)
      const out = responseHeaders(h, own)
      t.set({ responseHeaders: plainHeaders(out) })
      res.writeHead(Number(h[':status']), out)
      stream.once('trailers', (trailers) =>
        res.addTrailers(responseHeaders(trailers, own) as Record<string, string>),
      )
      responseBody(stream, own, t, readsModel).pipe(res)
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
    t?: RequestTracker,
    readsModel = false,
  ) {
    upstream.once('response', (up) => {
      if (tokenise) {
        const { exchange, url } = tokenise
        return tokenised(exchange, url, up.statusCode ?? 502, up.headers, up, res, own, t)
      }
      const out = responseHeaders(up.headers, own)
      t?.set({ responseHeaders: plainHeaders(out) })
      res.writeHead(up.statusCode ?? 502, out)
      up.once('end', () => {
        if (Object.keys(up.trailers).length) {
          res.addTrailers(responseHeaders(up.trailers, own) as Record<string, string>)
        }
      })
      responseBody(up, own, t, readsModel).pipe(res)
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
    const scrubbed = (value: string) => (scrubs ? scrubValue(own, value) : value)
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
      const out = scrubs ? scrubHeaders(own, up.headers) : up.headers
      upgraded({ status: up.statusCode, responseHeaders: plainHeaders(out) })
      const lines = [`HTTP/1.1 ${up.statusCode} ${up.statusMessage}`]
      for (let i = 0; i < up.rawHeaders.length; i += 2) {
        lines.push(`${up.rawHeaders[i]}: ${scrubbed(up.rawHeaders[i + 1] ?? '')}`)
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
