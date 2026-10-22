import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import http from 'node:http'
import http2 from 'node:http2'
import https from 'node:https'
import net from 'node:net'
import { duplexPair } from 'node:stream'
import { after, before, describe, test } from 'node:test'
import tls from 'node:tls'
import { gzipSync } from 'node:zlib'
import { createCertificateAuthority, issueServerCertificate } from '../src/egress/cert.ts'
import { link } from '../src/egress/mux.ts'
import type { NetworkPolicy } from '../src/egress/policy.ts'
import {
  createEgressProxy,
  type EgressEvent,
  type EgressProxy,
  type EgressProxyOptions,
} from '../src/egress/proxy.ts'
import type { RequestTransformation } from '../src/egress/rules.ts'
import type { Substitution } from '../src/egress/substitution.ts'

const PLACEHOLDER = `aisdkhc_${'P'.repeat(43)}`
const REAL = 'crsr_real_integration_key_0123456789abcdef'
const HOST = 'api.upstream.test'
/** Real JWTs as an exchange returns them: header, claims with an `exp`, signature. */
const jwt = (claims: object, signature: string) =>
  [{ alg: 'HS256', typ: 'JWT' }, claims]
    .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url'))
    .concat(signature)
    .join('.')
const ACCESS = jwt({ sub: 'user_1', exp: 2_000_000_000 }, 'real-access-signature-0123456789')
const REFRESH = jwt({ sub: 'user_1', exp: 2_100_000_000 }, 'real-refresh-signature-987654321')
const OTHER = 'other.upstream.test'

type Seen = { host: string; method: string; path: string; headers: http.IncomingHttpHeaders }

/** Local HTTPS upstreams (HTTP/1.1 and HTTP/2) that record what reached them. */
const upstreamCa = createCertificateAuthority()
const seen: Seen[] = []
const record = (host: string, req: http.IncomingMessage | http2.Http2ServerRequest) =>
  seen.push({ host, method: req.method ?? '', path: req.url ?? '', headers: { ...req.headers } })

function startUpstream(host: string, h2: boolean): Promise<{ port: number; close(): void }> {
  const leaf = issueServerCertificate(upstreamCa, host)
  const creds = { key: leaf.key.export({ type: 'pkcs8', format: 'pem' }), cert: leaf.cert }
  const handler = (
    req: http.IncomingMessage | http2.Http2ServerRequest,
    res: http.ServerResponse | http2.Http2ServerResponse,
  ) => {
    record(host, req)
    let body = ''
    req.on('data', (d) => {
      body += d
    })
    req.on('end', () => {
      const out = res as http.ServerResponse
      if (req.url?.startsWith('/echo')) {
        const echo = JSON.stringify({ headers: req.headers, path: req.url, body })
        out.writeHead(200, {
          'content-type': 'application/json',
          'x-echo-authorization': String(req.headers.authorization ?? ''),
        })
        return out.end(echo)
      }
      if (req.url?.startsWith('/tokens/')) {
        const auth = String(req.headers.authorization ?? '')
        if (req.url === '/tokens/denied') {
          out.writeHead(401, { 'content-type': 'application/json' })
          return out.end(JSON.stringify({ error: 'unauthorized', auth }))
        }
        if (req.url === '/tokens/gzip') {
          out.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
          return out.end(gzipSync(JSON.stringify({ accessToken: ACCESS, refreshToken: REFRESH })))
        }
        if (req.url === '/tokens/echo') {
          out.writeHead(200, { 'content-type': 'application/json' })
          return out.end(JSON.stringify({ accessToken: ACCESS, refreshToken: REFRESH, auth }))
        }
        if (req.url === '/tokens/garbled') {
          out.writeHead(200, { 'content-type': 'text/plain' })
          return out.end(`oops ${ACCESS}`)
        }
        out.writeHead(200, { 'content-type': 'application/json' })
        return out.end(JSON.stringify({ accessToken: ACCESS, refreshToken: REFRESH, kind: 'user' }))
      }
      if (req.url === '/responses') {
        // OpenAI's Responses API streams its first event with the request's instructions (which
        // may mention a "model" in a JSON string) before the model that served it.
        out.writeHead(200, {
          'content-type': 'text/event-stream',
          'x-accept-encoding': String(req.headers['accept-encoding'] ?? ''),
        })
        const created = JSON.stringify({
          type: 'response.created',
          response: {
            id: 'resp_1',
            instructions: 'Answer as "model": "not-this-one".',
            model: 'gpt-5.4-mini-2026-03-17',
            reasoning: { effort: 'medium', summary: null },
          },
        })
        const event = `event: response.created\ndata: ${created}\n\n`
        const cut = event.indexOf('mini-2026')
        out.write(event.slice(0, cut))
        return setTimeout(() => out.end(`${event.slice(cut)}data: [DONE]\n\n`), 20)
      }
      if (req.url === '/trailers') {
        out.writeHead(200, { 'content-type': 'application/grpc', trailer: 'grpc-status' })
        out.write('payload')
        out.addTrailers({ 'grpc-status': '0' })
        return out.end()
      }
      out.writeHead(200, { 'content-type': 'application/json', 'x-proto': req.httpVersion })
      out.end(JSON.stringify({ authorization: req.headers.authorization ?? null, body }))
    })
  }
  const server = h2
    ? http2.createSecureServer({ ...creds, allowHTTP1: true }, handler)
    : https.createServer(creds, handler)
  server.on('upgrade', (req: http.IncomingMessage, socket: net.Socket) => {
    record(host, req)
    const accept = createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    const echoed = req.headers.authorization
      ? `x-echo-authorization: ${req.headers.authorization}\r\n`
      : ''
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n${echoed}\r\n`,
    )
    socket.pipe(socket)
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: (server.address() as net.AddressInfo).port,
        close: () => server.close(),
      }),
    ),
  )
}

const rule = (port: number): RequestTransformation => ({
  match: {
    host: HOST,
    path: { exact: '/auth/exchange_user_api_key' },
    method: ['POST'],
    headers: [{ key: { exact: 'Authorization' }, value: { exact: `Bearer ${PLACEHOLDER}` } }],
  },
  transform: { headers: { Authorization: `Bearer ${REAL}` } },
  ...(port ? {} : {}),
})

/** The gateway's proxy on a local TCP port, as the in-container forwarder would reach it. */
async function startProxy(
  policy: NetworkPolicy = { mode: 'allow-all' },
  extra: Pick<
    EgressProxyOptions,
    'endpoints' | 'onRefused' | 'onUnsubstituted' | 'derivedTokens' | 'onEvent' | 'modelResponses'
  > = {},
  /** Hand each connection over as a plain Duplex, as the gateway's mux streams are. */
  asMux = false,
) {
  const ca = createCertificateAuthority()
  const lines: string[] = []
  const proxy = createEgressProxy({
    ...extra,
    ca,
    policy,
    log: (l) => {
      lines.push(l)
      if (process.env.DBG) console.error(l)
    },
    upstreamCA: upstreamCa.cert,
    lookup: async (host) => {
      if (host === 'nxdomain.test') throw new Error('ENOTFOUND')
      return host.endsWith('.test') ? ['127.0.0.1'] : ['203.0.113.1']
    },
    allowLoopback: true,
  })
  // Each connection reaches the proxy as a plain Duplex, as the gateway's mux streams do.
  const raw = new Set<net.Socket>()
  const server = net.createServer((s) => {
    if (!asMux) return proxy.handle(s)
    raw.add(s)
    const [ours, theirs] = duplexPair()
    link(s, ours)
    proxy.handle(theirs)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    proxy,
    ca,
    lines,
    port: (server.address() as net.AddressInfo).port,
    close() {
      proxy.close()
      for (const s of raw) s.destroy()
      server.close()
    },
  }
}

type Gw = Awaited<ReturnType<typeof startProxy>>

/** CONNECTs through the proxy and returns the raw tunnel, or the refusal's status and body. */
function connect(gw: Gw, host: string, port: number) {
  return new Promise<
    { ok: true; socket: net.Socket } | { ok: false; status: number; body: string }
  >((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: gw.port,
      method: 'CONNECT',
      path: `${host}:${port}`,
    })
    req.once('connect', (res, socket, head) => {
      if (res.statusCode === 200) return resolve({ ok: true, socket })
      let body = head.toString()
      socket.on('data', (d) => {
        body += d
      })
      socket.on('end', () => resolve({ ok: false, status: res.statusCode ?? 0, body }))
      socket.on('error', () => resolve({ ok: false, status: res.statusCode ?? 0, body }))
    })
    req.once('error', reject)
    req.end()
  })
}

/** An HTTPS request through the proxy, trusting the gateway's CA as the container does. */
async function viaProxy(
  gw: Gw,
  host: string,
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string },
) {
  const tunnel = await connect(gw, host, port)
  if (!tunnel.ok) return { status: tunnel.status, body: tunnel.body, headers: {} }
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>(
    (resolve, reject) => {
      const req = https.request(
        {
          host,
          port,
          method: options.method ?? 'GET',
          path: options.path ?? '/',
          headers: options.headers,
          createConnection: () =>
            tls.connect({ socket: tunnel.socket, servername: host, ca: gw.ca.cert }),
        },
        (res) => {
          let body = ''
          res.on('data', (d) => {
            body += d
          })
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
        },
      )
      req.once('error', reject)
      req.end(options.body)
    },
  )
}

/** The same over HTTP/2, as the Cursor CLI's Connect clients can. */
async function viaProxyH2(gw: Gw, host: string, port: number, path: string, auth = '') {
  const tunnel = await connect(gw, host, port)
  if (!tunnel.ok) throw new Error(`refused: ${tunnel.status}`)
  const session = http2.connect(`https://${host}:${port}`, {
    createConnection: () =>
      tls.connect({
        socket: tunnel.socket,
        servername: host,
        ca: gw.ca.cert,
        ALPNProtocols: ['h2'],
      }),
  })
  try {
    return await new Promise<{ status: number; body: string; trailers: http2.IncomingHttpHeaders }>(
      (resolve, reject) => {
        const stream = session.request({ ':method': 'POST', ':path': path, authorization: auth })
        let status = 0
        let body = ''
        let trailers: http2.IncomingHttpHeaders = {}
        stream.on('response', (h) => {
          status = Number(h[':status'])
        })
        stream.on('trailers', (t) => {
          trailers = t
        })
        stream.on('data', (d) => {
          body += d
        })
        stream.on('end', () => resolve({ status, body, trailers }))
        stream.on('error', reject)
        stream.end('{}')
      },
    )
  } finally {
    session.close()
  }
}

const everything = () => JSON.stringify(seen)

describe('egress proxy', () => {
  let h1: { port: number; close(): void }
  let h2: { port: number; close(): void }
  let gw: Gw
  before(async () => {
    h1 = await startUpstream(HOST, false)
    h2 = await startUpstream(HOST, true)
    gw = await startProxy()
    gw.proxy.addTransformations([rule(0)])
  })
  after(() => {
    gw.close()
    h1.close()
    h2.close()
  })

  test('swaps the placeholder for the real key on the matching request (HTTP/1.1)', async () => {
    seen.length = 0
    const r = await viaProxy(gw, HOST, h1.port, {
      method: 'POST',
      path: '/auth/exchange_user_api_key',
      headers: { authorization: `Bearer ${PLACEHOLDER}`, 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(r.status, 200)
    assert.equal(JSON.parse(r.body).authorization, `Bearer ${REAL}`)
    assert.equal(JSON.parse(r.body).body, '{}')
    assert.equal(seen.length, 1)
    assert.doesNotMatch(
      everything(),
      new RegExp(PLACEHOLDER),
      'the placeholder never reaches upstream',
    )
    assert.ok(gw.lines.some((l) => l.includes('decrypt')))
    assert.ok(gw.lines.some((l) => l.endsWith('(set authorization)')))
    assert.doesNotMatch(
      gw.lines.join('\n'),
      new RegExp(`${REAL}|${PLACEHOLDER}`),
      'logs are redacted',
    )
  })

  test('swaps over HTTP/2 and passes response trailers through', async () => {
    seen.length = 0
    const r = await viaProxyH2(
      gw,
      HOST,
      h2.port,
      '/auth/exchange_user_api_key',
      `Bearer ${PLACEHOLDER}`,
    )
    assert.equal(r.status, 200)
    assert.equal(JSON.parse(r.body).authorization, `Bearer ${REAL}`)
    assert.equal(seen[0]?.headers[':method'], 'POST', 'upstream saw HTTP/2')
    const t = await viaProxyH2(gw, HOST, h2.port, '/trailers', 'Bearer x')
    assert.equal(t.body, 'payload')
    assert.equal(t.trailers['grpc-status'], '0')
    assert.doesNotMatch(everything(), new RegExp(PLACEHOLDER))
  })

  test('non-matching requests on the decrypted host never get the real key', async () => {
    seen.length = 0
    const cases = [
      { method: 'GET', path: '/auth/exchange_user_api_key', auth: `Bearer ${PLACEHOLDER}` },
      { method: 'POST', path: '/v1/other', auth: `Bearer ${PLACEHOLDER}` },
      { method: 'POST', path: '/auth/exchange_user_api_key', auth: 'Bearer aisdkhc_forged' },
    ]
    for (const c of cases) {
      const r = await viaProxy(gw, HOST, h1.port, {
        method: c.method,
        path: c.path,
        headers: { authorization: c.auth },
      })
      assert.equal(JSON.parse(r.body).authorization, c.auth, JSON.stringify(c))
    }
    assert.equal(seen.length, 3)
    assert.doesNotMatch(everything(), new RegExp(REAL))
  })

  test('other hosts are tunnelled end to end: never decrypted, never given the key', async () => {
    const other = await startUpstream(OTHER, false)
    try {
      seen.length = 0
      // The client trusts only the upstream's CA: that works only if the proxy didn't decrypt.
      const tunnel = await connect(gw, OTHER, other.port)
      assert.ok(tunnel.ok)
      const body = await new Promise<string>((resolve, reject) => {
        const req = https.request(
          {
            host: OTHER,
            port: other.port,
            method: 'POST',
            path: '/auth/exchange_user_api_key',
            headers: { authorization: `Bearer ${PLACEHOLDER}` },
            createConnection: () =>
              tls.connect({ socket: tunnel.socket, servername: OTHER, ca: upstreamCa.cert }),
          },
          (res) => {
            let b = ''
            res.on('data', (d) => {
              b += d
            })
            res.on('end', () => resolve(b))
          },
        )
        req.once('error', reject)
        req.end()
      })
      assert.equal(JSON.parse(body).authorization, `Bearer ${PLACEHOLDER}`)
      assert.doesNotMatch(everything(), new RegExp(REAL))
      assert.ok(gw.lines.some((l) => l.includes(`CONNECT ${OTHER}:${other.port} tunnel`)))
    } finally {
      other.close()
    }
  })

  test('websocket upgrades on a decrypted host carry transformed headers', async () => {
    seen.length = 0
    gw.proxy.addTransformations([
      {
        match: { host: HOST, path: { exact: '/ws' } },
        transform: { headers: { 'x-token': REAL } },
      },
    ])
    const tunnel = await connect(gw, HOST, h1.port)
    assert.ok(tunnel.ok)
    const secure = tls.connect({ socket: tunnel.socket, servername: HOST, ca: gw.ca.cert })
    await new Promise((r) => secure.once('secureConnect', r))
    secure.write(
      `GET /ws HTTP/1.1\r\nhost: ${HOST}\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\nsec-websocket-version: 13\r\nx-token: placeholder\r\n\r\n`,
    )
    let text = ''
    await new Promise<void>((resolve) => {
      secure.on('data', (d) => {
        text += d
        if (text.includes('\r\n\r\n') && !text.includes('echo-me')) secure.write('echo-me')
        if (text.includes('echo-me')) resolve()
      })
    })
    assert.match(text, /^HTTP\/1.1 101/)
    assert.equal(seen[0]?.headers['x-token'], REAL)
    secure.destroy()
  })

  test('setTransformations replaces the rules', async () => {
    const gw2 = await startProxy()
    try {
      gw2.proxy.addTransformations([rule(0)])
      gw2.proxy.setTransformations([])
      seen.length = 0
      // With no rules the host is tunnelled blind, so the gateway's CA isn't presented.
      await assert.rejects(
        viaProxy(gw2, HOST, h1.port, { method: 'POST', path: '/auth/exchange_user_api_key' }),
        /self-signed|unable to verify|certificate/i,
      )
    } finally {
      gw2.close()
    }
  })

  test('plain HTTP goes through without decryption or credentials', async () => {
    const plain = http.createServer((req, res) => {
      record('plain', req)
      res.end('plain ok')
    })
    await new Promise<void>((r) => plain.listen(0, '127.0.0.1', r))
    const port = (plain.address() as net.AddressInfo).port
    try {
      const body = await new Promise<string>((resolve, reject) => {
        http
          .get(
            { host: '127.0.0.1', port: gw.port, path: `http://plain.upstream.test:${port}/x` },
            (res) => {
              let b = ''
              res.on('data', (d) => {
                b += d
              })
              res.on('end', () => resolve(b))
            },
          )
          .once('error', reject)
      })
      assert.equal(body, 'plain ok')
    } finally {
      plain.close()
    }
  })
})

/** An absolute-form `https://` request sent to the proxy without CONNECT, as Puppeteer 19 does. */
function absolute(
  gw: Gw,
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
) {
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>(
    (resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: gw.port,
          method: options.method ?? 'GET',
          path: url,
          headers: options.headers,
        },
        (res) => {
          let body = ''
          res.on('data', (d) => {
            body += d
          })
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
        },
      )
      req.once('error', reject)
      req.end(options.body)
    },
  )
}

describe('absolute-form https requests through the proxy', () => {
  const SECRET = 'AIza-real-secret-value-0123456789abcdef'
  const HOLDER = `reeval_secret_${'Q'.repeat(32)}`
  let h1: { port: number; close(): void }
  before(async () => {
    h1 = await startUpstream(HOST, false)
  })
  after(() => h1.close())

  test('an allowed host is fetched over TLS and recorded like a decrypted request', async () => {
    const events: EgressEvent[] = []
    const gw = await startProxy(
      { mode: 'custom', allowedHosts: [HOST] },
      { onEvent: (e) => events.push(e) },
      true,
    )
    try {
      seen.length = 0
      const r = await absolute(gw, `https://${HOST}:${h1.port}/echo?x=1`, {
        method: 'POST',
        body: 'hello',
      })
      assert.equal(r.status, 200)
      const echo = JSON.parse(r.body) as { path: string; body: string; headers: object }
      assert.equal(echo.path, '/echo?x=1')
      assert.equal(echo.body, 'hello')
      assert.equal(seen[0]?.headers.host, `${HOST}:${h1.port}`, "the URL's authority, not Host")
      for (let i = 0; i < 100 && !events.some((e) => e.type === 'request'); i++) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      const request = events.find((e) => e.type === 'request')
      assert.deepEqual(
        request?.type === 'request' && [
          request.method,
          request.url,
          request.via,
          request.allowed,
          request.status,
          request.sent,
        ],
        ['POST', `https://${HOST}/echo`, 'decrypted', true, 200, 5],
      )
      assert.deepEqual(
        gw.proxy.traffic().contacted.map((h) => [h.host, h.port, h.connections]),
        [[HOST, h1.port, 1]],
      )
    } finally {
      gw.close()
    }
  })

  test('a host the policy refuses gets its 403, and nothing goes upstream', async () => {
    const gw = await startProxy({ mode: 'custom', allowedHosts: [OTHER] })
    try {
      seen.length = 0
      const r = await absolute(gw, `https://${HOST}:${h1.port}/echo`)
      assert.equal(r.status, 403)
      assert.match(r.body, /blocked by the reeval egress policy: .* isn't in the allowlist/)
      assert.equal(seen.length, 0)
      assert.deepEqual(
        gw.proxy.traffic().blocked.map((h) => [h.host, h.port]),
        [[HOST, h1.port]],
      )
    } finally {
      gw.close()
    }
  })

  test('brokered: the credential header is set and secrets are swapped, then scrubbed back', async () => {
    const gw = await startProxy()
    try {
      gw.proxy.addTransformations([rule(0)])
      gw.proxy.setSubstitutions([
        {
          name: 'GEMINI_API_KEY',
          placeholder: HOLDER,
          value: SECRET,
          hosts: [HOST],
          in: ['header'],
        },
      ])
      seen.length = 0
      const keyed = await absolute(gw, `https://${HOST}:${h1.port}/auth/exchange_user_api_key`, {
        method: 'POST',
        headers: { authorization: `Bearer ${PLACEHOLDER}` },
        body: '{}',
      })
      assert.equal(keyed.status, 200)
      assert.equal(seen[0]?.headers.authorization, `Bearer ${REAL}`)
      const echoed = await absolute(gw, `https://${HOST}:${h1.port}/echo`, {
        headers: { 'x-goog-api-key': HOLDER },
      })
      assert.equal(seen[1]?.headers['x-goog-api-key'], SECRET)
      assert.doesNotMatch(echoed.body, new RegExp(SECRET), 'the response is scrubbed')
      assert.match(echoed.body, new RegExp(HOLDER))
      assert.doesNotMatch(gw.lines.join('\n'), new RegExp(`${REAL}|${SECRET}`))
    } finally {
      gw.close()
    }
  })

  test("an unlisted brokered endpoint is refused, as over CONNECT, and a scheme it can't speak is a 400", async () => {
    const gw = await startProxy(
      { mode: 'allow-all' },
      { endpoints: [{ host: HOST, path: { exact: '/v1/messages' }, method: ['POST'] }] },
    )
    try {
      gw.proxy.addTransformations([rule(0)])
      seen.length = 0
      const r = await absolute(gw, `https://${HOST}:${h1.port}/auth/exchange_user_api_key`, {
        method: 'POST',
        headers: { authorization: `Bearer ${PLACEHOLDER}` },
      })
      assert.equal(r.status, 403)
      assert.match(r.body, /isn't one of the endpoints reeval brokers it for/)
      assert.equal(seen.length, 0)
      const ftp = await absolute(gw, `ftp://${HOST}/file`)
      assert.equal(ftp.status, 400)
      assert.match(ftp.body, /expected an http:\/\/ or https:\/\/ URL, not ftp:/)
    } finally {
      gw.close()
    }
  })

  test('an IPv6 literal goes upstream with its Host in brackets', async () => {
    const leaf = issueServerCertificate(upstreamCa, '::1')
    const v6 = https.createServer(
      { key: leaf.key.export({ type: 'pkcs8', format: 'pem' }), cert: leaf.cert },
      (req, res) => {
        record('::1', req)
        res.end('ok')
      },
    )
    await new Promise<void>((r) => v6.listen(0, '::1', r))
    const gw = await startProxy()
    try {
      seen.length = 0
      const { port } = v6.address() as net.AddressInfo
      const r = await absolute(gw, `https://[::1]:${port}/v6`)
      assert.equal(r.status, 200)
      assert.equal(seen[0]?.headers.host, `[::1]:${port}`)
    } finally {
      gw.close()
      v6.close()
    }
  })
})

describe('brokered endpoints through the proxy', () => {
  // A host-wide rule, like the Claude Code adapter's, narrowed by the endpoint list.
  const hostWide: RequestTransformation = {
    match: {
      host: HOST,
      headers: [{ key: { exact: 'Authorization' }, value: { exact: `Bearer ${PLACEHOLDER}` } }],
    },
    transform: { headers: { Authorization: `Bearer ${REAL}` } },
  }
  let h1: { port: number; close(): void }
  let h2: { port: number; close(): void }
  let gw: Gw
  const refused: string[] = []
  before(async () => {
    h1 = await startUpstream(HOST, false)
    h2 = await startUpstream(HOST, true)
    gw = await startProxy(
      { mode: 'allow-all' },
      {
        endpoints: [{ host: HOST, path: { exact: '/v1/messages' }, method: ['POST'] }],
        onRefused: ({ method, url }) => refused.push(`${method} ${url}`),
      },
    )
    gw.proxy.addTransformations([hostWide])
  })
  after(() => {
    gw.close()
    h1.close()
    h2.close()
  })
  const auth = { authorization: `Bearer ${PLACEHOLDER}` }

  test('a listed endpoint gets the real key', async () => {
    seen.length = 0
    const r = await viaProxy(gw, HOST, h1.port, {
      method: 'POST',
      path: '/v1/messages?beta=true',
      headers: auth,
    })
    assert.equal(r.status, 200)
    assert.equal(JSON.parse(r.body).authorization, `Bearer ${REAL}`)
    // The twin of the absence checks below: the same search finds a request that got through.
    assert.match(everything(), /\/v1\/messages/)
  })

  test('an unlisted endpoint fails at once with a 403 that says why, and never goes upstream', async () => {
    seen.length = 0
    refused.length = 0
    for (const [method, path] of [
      ['GET', '/v1/models'],
      ['POST', '/v1/files'],
      ['GET', '/v1/messages'],
    ] as const) {
      const started = Date.now()
      const r = await viaProxy(gw, HOST, h1.port, { method, path, headers: auth })
      assert.equal(r.status, 403, `${method} ${path}`)
      assert.match(r.body, /refused .* isn't one of the endpoints reeval brokers it for/)
      assert.ok(Date.now() - started < 5_000, 'refused, not left hanging')
    }
    assert.equal(seen.length, 0, 'nothing reached upstream')
    assert.doesNotMatch(everything(), new RegExp(`${REAL}|${PLACEHOLDER}`))
    assert.deepEqual(refused, [
      `GET https://${HOST}/v1/models`,
      `POST https://${HOST}/v1/files`,
      `GET https://${HOST}/v1/messages`,
    ])
    assert.ok(gw.lines.some((l) => l.endsWith('refused (not a brokered endpoint)')))
  })

  test('the refusal holds over HTTP/2', async () => {
    seen.length = 0
    const r = await viaProxyH2(gw, HOST, h2.port, '/v1/files', `Bearer ${PLACEHOLDER}`)
    assert.equal(r.status, 403)
    assert.equal(seen.length, 0)
  })

  test('a request without the placeholder is not ours to refuse', async () => {
    seen.length = 0
    const r = await viaProxy(gw, HOST, h1.port, {
      path: '/v1/models',
      headers: { authorization: 'Bearer sk-not-brokered' },
    })
    assert.equal(r.status, 200)
    assert.equal(JSON.parse(r.body).authorization, 'Bearer sk-not-brokered')
  })
})

describe('egress policy through the proxy', () => {
  let h1: { port: number; close(): void }
  before(async () => {
    h1 = await startUpstream(HOST, false)
  })
  after(() => h1.close())

  test('deny-all refuses every CONNECT with 403 and a reason', async () => {
    const gw = await startProxy({ mode: 'deny-all' })
    try {
      const r = await connect(gw, HOST, h1.port)
      assert.equal(r.ok, false)
      assert.equal(!r.ok && r.status, 403)
      assert.match(!r.ok ? r.body : '', /blocked by the reeval egress policy/)
      assert.ok(gw.lines.some((l) => l.includes('denied')))
    } finally {
      gw.close()
    }
  })

  test('an allowlist lets listed hosts through and refuses the rest', async () => {
    const gw = await startProxy({ mode: 'custom', allowedHosts: [HOST] })
    try {
      gw.proxy.addTransformations([rule(0)])
      const ok = await viaProxy(gw, HOST, h1.port, {
        method: 'POST',
        path: '/auth/exchange_user_api_key',
        headers: { authorization: `Bearer ${PLACEHOLDER}` },
      })
      assert.equal(JSON.parse(ok.body).authorization, `Bearer ${REAL}`)
      const refused = await connect(gw, 'elsewhere.test', h1.port)
      assert.equal(!refused.ok && refused.status, 403)
      assert.match(!refused.ok ? refused.body : '', /isn't in the allowlist/)
      const plain = await new Promise<number>((resolve) =>
        http
          .get({ host: '127.0.0.1', port: gw.port, path: 'http://elsewhere.test/' }, (res) => {
            res.resume()
            resolve(res.statusCode ?? 0)
          })
          .once('error', () => resolve(0)),
      )
      assert.equal(plain, 403)
    } finally {
      gw.close()
    }
  })

  test('records each host reached, with its bytes, and each host refused, with why', async () => {
    const gw = await startProxy({ mode: 'custom', allowedHosts: [HOST] }, {}, true)
    try {
      gw.proxy.addTransformations([rule(0)])
      const ok = await viaProxy(gw, HOST, h1.port, { path: '/echo' })
      assert.equal(ok.status, 200)
      for (let i = 0; i < 2; i++) assert.equal((await connect(gw, OTHER, h1.port)).ok, false)
      const plain = await new Promise<number>((resolve) =>
        http
          .get({ host: '127.0.0.1', port: gw.port, path: 'http://elsewhere.test/' }, (res) => {
            res.resume()
            resolve(res.statusCode ?? 0)
          })
          .once('error', () => resolve(0)),
      )
      assert.equal(plain, 403)
      const { contacted, blocked } = gw.proxy.traffic()
      assert.deepEqual(
        contacted.map((h) => [h.host, h.port, h.connections]),
        [[HOST, h1.port, 1]],
      )
      const [reached] = contacted
      assert.ok((reached?.sent ?? 0) > 0, 'the request and the TLS handshake count as sent')
      assert.ok((reached?.received ?? 0) > ok.body.length, 'the response counts as received')
      assert.deepEqual(blocked, [
        {
          host: 'elsewhere.test',
          port: 80,
          connections: 1,
          reason: "elsewhere.test isn't in the allowlist",
        },
        { host: OTHER, port: h1.port, connections: 2, reason: `${OTHER} isn't in the allowlist` },
      ])
    } finally {
      gw.close()
    }
  })

  test('allow-all records what it lets through, and a name that never resolved as refused', async () => {
    const gw = await startProxy({ mode: 'allow-all' }, {}, true)
    try {
      assert.ok((await connect(gw, HOST, h1.port)).ok)
      assert.equal((await connect(gw, 'nxdomain.test', 443)).ok, false)
      const { contacted, blocked } = gw.proxy.traffic()
      assert.deepEqual(
        contacted.map((h) => h.host),
        [HOST],
      )
      assert.deepEqual(blocked, [
        {
          host: 'nxdomain.test',
          port: 443,
          connections: 1,
          reason: "can't resolve nxdomain.test: ENOTFOUND",
        },
      ])
    } finally {
      gw.close()
    }
  })

  test('setPolicy takes effect for new connections', async () => {
    const gw = await startProxy({ mode: 'allow-all' })
    try {
      assert.ok((await connect(gw, HOST, h1.port)).ok)
      gw.proxy.setPolicy({ mode: 'deny-all' })
      assert.equal((await connect(gw, HOST, h1.port)).ok, false)
    } finally {
      gw.close()
    }
  })

  test('the host loopback stays out of reach by default, over CONNECT and plain HTTP', async () => {
    const ca = createCertificateAuthority()
    const proxy: EgressProxy = createEgressProxy({ ca, policy: { mode: 'allow-all' } })
    const server = net.createServer((s) => proxy.handle(s))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    let reached = 0
    const plain = http.createServer((_, res) => {
      reached++
      res.end('reached')
    })
    await new Promise<void>((r) => plain.listen(0, '127.0.0.1', r))
    const plainPort = (plain.address() as net.AddressInfo).port
    try {
      const gw = { port: (server.address() as net.AddressInfo).port } as Gw
      for (const host of ['127.0.0.1', 'localhost', '[::1]', '[::]', '169.254.169.254']) {
        const r = await connect(gw, host, h1.port)
        assert.equal(!r.ok && r.status, 403, host)
        const status = await new Promise<number>((resolve) =>
          http
            .get(
              { host: '127.0.0.1', port: gw.port, path: `http://${host}:${plainPort}/` },
              (res) => {
                res.resume()
                resolve(res.statusCode ?? 0)
              },
            )
            .once('error', () => resolve(0)),
        )
        assert.equal(status, 403, `plain HTTP to ${host}`)
      }
      assert.equal(reached, 0, 'the host listener saw nothing')
    } finally {
      proxy.close()
      server.close()
      plain.close()
    }
  })
})

describe('brokered secrets through the proxy', () => {
  const SECRET = 'AIza-real-secret-value-0123456789abcdef'
  const HOLDER = `reeval_secret_${'Q'.repeat(32)}`
  const sub = (over: Partial<Substitution> = {}): Substitution => ({
    name: 'GEMINI_API_KEY',
    placeholder: HOLDER,
    value: SECRET,
    hosts: [HOST],
    in: ['header'],
    ...over,
  })
  let h1: { port: number; close(): void }
  let h2: { port: number; close(): void }
  let other: { port: number; close(): void }
  before(async () => {
    h1 = await startUpstream(HOST, false)
    h2 = await startUpstream(HOST, true)
    other = await startUpstream(OTHER, false)
  })
  after(() => {
    h1.close()
    h2.close()
    other.close()
  })
  const echoOf = (r: { body: string }) =>
    JSON.parse(r.body) as { headers: Record<string, string>; path: string; body: string }
  const reachedUpstream = () => JSON.stringify(seen)

  test('a placeholder inside a header value is swapped on its own host, and logged by name only', async () => {
    const gw = await startProxy()
    try {
      gw.proxy.setSubstitutions([sub()])
      seen.length = 0
      await viaProxy(gw, HOST, h1.port, {
        path: '/echo',
        headers: { authorization: `Bearer ${HOLDER}`, 'x-goog-api-key': HOLDER },
      })
      assert.equal(seen[0]?.headers.authorization, `Bearer ${SECRET}`)
      assert.equal(seen[0]?.headers['x-goog-api-key'], SECRET)
      assert.ok(
        gw.lines.some((l) => l.includes('(substituted GEMINI_API_KEY)')),
        gw.lines.join('\n'),
      )
      assert.doesNotMatch(gw.lines.join('\n'), new RegExp(`${SECRET}|${HOLDER}`))
    } finally {
      gw.close()
    }
  })

  test('reports each request once done, with bytes and names, and each DNS decision', async () => {
    const events: EgressEvent[] = []
    const gw = await startProxy(
      { mode: 'custom', allowedHosts: [HOST, OTHER] },
      { onEvent: (e) => events.push(e) },
      true,
    )
    const settled = async (n: number) => {
      for (let i = 0; i < 100 && events.filter((e) => e.type === 'request').length < n; i++) {
        await new Promise((r) => setTimeout(r, 20))
      }
      return events.filter((e) => e.type === 'request')
    }
    try {
      gw.proxy.setSubstitutions([sub()])
      const r = await viaProxy(gw, HOST, h1.port, {
        method: 'POST',
        path: '/echo',
        headers: { authorization: `Bearer ${HOLDER}` },
        body: 'hello',
      })
      assert.equal(r.status, 200)
      const [decrypted] = await settled(1)
      assert.deepEqual(
        { ...decrypted, ms: 0, requestHeaders: undefined, responseHeaders: undefined },
        {
          type: 'request',
          method: 'POST',
          url: `https://${HOST}/echo`,
          host: HOST,
          port: h1.port,
          via: 'decrypted',
          allowed: true,
          sent: 5,
          received: Buffer.byteLength(r.body),
          substituted: ['GEMINI_API_KEY'],
          credentials: [],
          ms: 0,
          status: 200,
          requestHeaders: undefined,
          responseHeaders: undefined,
        },
      )
      // Headers as the sandbox sent and got them: the placeholder, never the value.
      assert.equal(
        decrypted?.type === 'request' && decrypted.requestHeaders?.authorization,
        `Bearer ${HOLDER}`,
      )
      assert.equal(
        decrypted?.type === 'request' && decrypted.responseHeaders?.['x-echo-authorization'],
        `Bearer ${HOLDER}`,
      )
      assert.equal(JSON.stringify(events).includes(SECRET), false)

      // Another allowed host is tunnelled, and reported when the tunnel closes.
      const tunnel = await connect(gw, OTHER, other.port)
      assert.ok(tunnel.ok)
      await new Promise<void>((resolve, reject) => {
        const req = https.request(
          {
            host: OTHER,
            port: other.port,
            path: '/',
            createConnection: () =>
              tls.connect({ socket: tunnel.socket, servername: OTHER, ca: upstreamCa.cert }),
          },
          (res) => {
            res.resume()
            res.on('end', resolve)
          },
        )
        req.once('error', reject)
        req.end()
      })
      tunnel.socket.destroy()
      assert.equal((await connect(gw, 'elsewhere.test', 443)).ok, false)
      const [, tunnelled, refused] = await settled(3)
      assert.equal(tunnelled?.type === 'request' && tunnelled.via, 'tunnel')
      assert.ok(tunnelled?.type === 'request' && tunnelled.sent > 0 && tunnelled.received > 0)
      assert.deepEqual(
        refused?.type === 'request' && [
          refused.method,
          refused.url,
          refused.allowed,
          refused.status,
          refused.reason,
        ],
        ['CONNECT', 'elsewhere.test:443', false, 403, "elsewhere.test isn't in the allowlist"],
      )
      assert.deepEqual(
        events.filter((e) => e.type === 'dns').map((e) => [e.host, e.allowed]),
        [
          [HOST, true],
          [OTHER, true],
          ['elsewhere.test', false],
        ],
      )
    } finally {
      gw.close()
    }
  })

  test('responses from a brokered host have the value put back as the placeholder', async () => {
    const gw = await startProxy()
    try {
      gw.proxy.setSubstitutions([sub()])
      const r = await viaProxy(gw, HOST, h1.port, {
        path: '/echo',
        headers: { authorization: `Bearer ${HOLDER}` },
      })
      assert.doesNotMatch(r.body, new RegExp(SECRET), 'the echoed body is scrubbed')
      assert.match(r.body, new RegExp(HOLDER))
      assert.equal(r.headers['x-echo-authorization'], `Bearer ${HOLDER}`, 'and the headers')
      assert.equal(echoOf(r).headers['accept-encoding'], undefined, 'responses come uncompressed')
      // Twin: the upstream really got the value, so the check above could fail.
      assert.match(reachedUpstream(), new RegExp(SECRET))
    } finally {
      gw.close()
    }
  })

  test('a websocket upgrade from a brokered host has the value put back as the placeholder', async () => {
    const gw = await startProxy()
    try {
      gw.proxy.setSubstitutions([sub()])
      seen.length = 0
      const tunnel = await connect(gw, HOST, h1.port)
      assert.ok(tunnel.ok)
      const secure = tls.connect({ socket: tunnel.socket, servername: HOST, ca: gw.ca.cert })
      await new Promise((r) => secure.once('secureConnect', r))
      secure.write(
        `GET /ws HTTP/1.1\r\nhost: ${HOST}\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\nsec-websocket-version: 13\r\nauthorization: Bearer ${HOLDER}\r\n\r\n`,
      )
      let text = ''
      await new Promise<void>((resolve) => {
        secure.on('data', (d) => {
          text += d
          if (text.includes('\r\n\r\n')) resolve()
        })
      })
      secure.destroy()
      assert.match(text, /^HTTP\/1.1 101/)
      assert.doesNotMatch(text, new RegExp(SECRET), 'the upgrade response headers are scrubbed')
      assert.match(text, new RegExp(`x-echo-authorization: Bearer ${HOLDER}`))
      // Twin: the upstream really got the value, so the check above could fail.
      assert.equal(seen[0]?.headers.authorization, `Bearer ${SECRET}`)
    } finally {
      gw.close()
    }
  })

  test('HTTP/2: substituted on the way out, scrubbed on the way back', async () => {
    const gw = await startProxy()
    try {
      gw.proxy.setSubstitutions([sub()])
      seen.length = 0
      const r = await viaProxyH2(gw, HOST, h2.port, '/echo', `Bearer ${HOLDER}`)
      assert.equal(seen[0]?.headers.authorization, `Bearer ${SECRET}`)
      assert.equal(echoOf(r).headers.authorization, `Bearer ${HOLDER}`)
    } finally {
      gw.close()
    }
  })

  test('the query and the body are substituted only when a secret opts in', async () => {
    const gw = await startProxy()
    try {
      const request = () =>
        viaProxy(gw, HOST, h1.port, {
          method: 'POST',
          path: `/echo?key=${HOLDER}`,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key: HOLDER }),
        })
      gw.proxy.setSubstitutions([sub()])
      seen.length = 0
      await request()
      assert.equal(seen[0]?.path, `/echo?key=${HOLDER}`, 'headers only by default: query kept')
      assert.doesNotMatch(reachedUpstream(), new RegExp(SECRET))

      gw.proxy.setSubstitutions([sub({ in: ['header', 'query', 'body'] })])
      seen.length = 0
      const r = await request()
      assert.equal(seen[0]?.path, `/echo?key=${SECRET}`)
      assert.equal(seen[0]?.headers['content-length'], undefined, 're-framed, not a stale length')
      assert.match(reachedUpstream(), new RegExp(SECRET))
      assert.doesNotMatch(r.body, new RegExp(SECRET), 'the echo of the body is scrubbed')
    } finally {
      gw.close()
    }
  })

  test('a placeholder left where its secret is not substituted is reported, by name', async () => {
    const reported: unknown[] = []
    const gw = await startProxy(undefined, { onUnsubstituted: (e) => reported.push(e) })
    try {
      gw.proxy.setSubstitutions([sub()])
      await viaProxy(gw, HOST, h1.port, {
        path: `/echo?key=${HOLDER}`,
        headers: { authorization: HOLDER },
      })
      assert.deepEqual(reported, [
        {
          name: 'GEMINI_API_KEY',
          where: 'query',
          in: ['header'],
          method: 'GET',
          url: `https://${HOST}/echo`,
        },
      ])
      assert.ok(
        gw.lines.some((l) => l.includes("kept GEMINI_API_KEY's placeholder in the query")),
        gw.lines.join('\n'),
      )
      // Twin: with the query opted in, the same request has nothing to report.
      reported.length = 0
      gw.proxy.setSubstitutions([sub({ in: ['header', 'query'] })])
      await viaProxy(gw, HOST, h1.port, { path: `/echo?key=${HOLDER}` })
      assert.deepEqual(reported, [])
    } finally {
      gw.close()
    }
  })

  test("a compressed request body isn't substituted: the placeholder goes up and fails closed", async () => {
    const gw = await startProxy()
    try {
      gw.proxy.setSubstitutions([sub({ in: ['header', 'body'] })])
      seen.length = 0
      await viaProxy(gw, HOST, h1.port, {
        method: 'POST',
        path: '/echo',
        headers: { 'content-encoding': 'x-custom' },
        body: HOLDER,
      })
      assert.doesNotMatch(reachedUpstream(), new RegExp(SECRET))
    } finally {
      gw.close()
    }
  })

  test("a secret isn't swapped on another host, nor another secret's", async () => {
    const gw = await startProxy()
    try {
      const b = sub({
        name: 'OTHER_KEY',
        placeholder: `reeval_secret_${'B'.repeat(32)}`,
        value: 'b-real-value-9876543210',
        hosts: [OTHER],
      })
      gw.proxy.setSubstitutions([sub(), b])
      seen.length = 0
      // OTHER is decrypted for its own secret, but GEMINI_API_KEY's placeholder stays as it is.
      await viaProxy(gw, OTHER, other.port, { path: '/echo', headers: { authorization: HOLDER } })
      assert.equal(seen[0]?.headers.authorization, HOLDER)
      await viaProxy(gw, HOST, h1.port, {
        path: '/echo',
        headers: { authorization: b.placeholder },
      })
      assert.equal(seen[1]?.headers.authorization, b.placeholder)
      assert.doesNotMatch(reachedUpstream(), new RegExp(`${SECRET}|${b.value}`))
    } finally {
      gw.close()
    }
  })

  test('a Host header naming another host than the CONNECT target is refused (domain fronting)', async () => {
    const gw = await startProxy()
    try {
      gw.proxy.setSubstitutions([sub({ hosts: [HOST, OTHER] })])
      seen.length = 0
      const r = await viaProxy(gw, HOST, h1.port, {
        path: '/echo',
        headers: { host: OTHER, authorization: HOLDER },
      })
      assert.equal(r.status, 421)
      assert.match(
        r.body,
        /the request names other\.upstream\.test, but the connection is to api\.upstream\.test/,
      )
      assert.equal(seen.length, 0, 'nothing reached the upstream')
      // Twin: the same request naming the CONNECT host goes through.
      const ok = await viaProxy(gw, HOST, h1.port, {
        path: '/echo',
        headers: { authorization: HOLDER },
      })
      assert.equal(ok.status, 200)
    } finally {
      gw.close()
    }
  })

  test('an absolute-form request target on a decrypted connection is refused (domain fronting)', async () => {
    const gw = await startProxy()
    try {
      gw.proxy.setSubstitutions([sub({ in: ['header', 'query'] })])
      seen.length = 0
      // The upstream routes by the request target's authority, not Host (RFC 9112 §3.2.2).
      const r = await viaProxy(gw, HOST, h1.port, {
        path: `https://${OTHER}/echo?key=${HOLDER}`,
        headers: { authorization: HOLDER },
      })
      assert.equal(r.status, 400)
      assert.match(r.body, /expected a path/)
      assert.equal(seen.length, 0, 'nothing reached the upstream')
      // Twin: the same request with a path goes through, keyed.
      const ok = await viaProxy(gw, HOST, h1.port, {
        path: `/echo?key=${HOLDER}`,
        headers: { authorization: HOLDER },
      })
      assert.equal(ok.status, 200)
      assert.equal(seen[0]?.path, `/echo?key=${SECRET}`)
    } finally {
      gw.close()
    }
  })

  test('plain HTTP is never substituted, even to a brokered host', async () => {
    const plain = http.createServer((req, res) => {
      record('plain', req)
      req.resume()
      res.end('ok')
    })
    await new Promise<void>((r) => plain.listen(0, '127.0.0.1', r))
    const gw = await startProxy()
    try {
      gw.proxy.setSubstitutions([
        sub({ hosts: [HOST, 'plain.upstream.test'], in: ['header', 'query'] }),
      ])
      seen.length = 0
      const port = (plain.address() as net.AddressInfo).port
      await new Promise<void>((resolve, reject) =>
        http
          .get(
            {
              host: '127.0.0.1',
              port: gw.port,
              path: `http://plain.upstream.test:${port}/x?key=${HOLDER}`,
              headers: { authorization: HOLDER },
            },
            (res) => res.resume().on('end', resolve),
          )
          .once('error', reject),
      )
      assert.equal(seen[0]?.headers.authorization, HOLDER)
      assert.equal(seen[0]?.path, `/x?key=${HOLDER}`)
    } finally {
      gw.close()
      plain.close()
    }
  })

  test('setSubstitutions replaces the set: an empty one decrypts nothing', async () => {
    const gw = await startProxy()
    try {
      gw.proxy.setSubstitutions([sub()])
      gw.proxy.setSubstitutions([])
      await assert.rejects(
        viaProxy(gw, HOST, h1.port, { path: '/echo' }),
        /self-signed|unable to verify|certificate/i,
        'tunnelled blind: the gateway CA is not presented',
      )
    } finally {
      gw.close()
    }
  })
})

describe('the model a response names, on a modelResponses endpoint', () => {
  const brokered: RequestTransformation = {
    match: {
      host: HOST,
      headers: [{ key: { exact: 'Authorization' }, value: { exact: `Bearer ${PLACEHOLDER}` } }],
    },
    transform: { headers: { Authorization: `Bearer ${REAL}` } },
  }
  let h1: { port: number; close(): void }
  let h2: { port: number; close(): void }
  before(async () => {
    h1 = await startUpstream(HOST, false)
    h2 = await startUpstream(HOST, true)
  })
  after(() => {
    h1.close()
    h2.close()
  })
  /** The one request's event, once the response has closed. */
  const requestEvent = async (events: EgressEvent[]) => {
    for (let i = 0; i < 100 && !events.some((e) => e.type === 'request'); i++)
      await new Promise((r) => setTimeout(r, 20))
    return events.find((e) => e.type === 'request')
  }
  const responses = (gw: Gw) =>
    viaProxy(gw, HOST, h1.port, {
      method: 'POST',
      path: '/responses',
      headers: { authorization: `Bearer ${PLACEHOLDER}`, 'accept-encoding': 'gzip, br, zstd' },
      body: '{}',
    })

  test('asks for it uncompressed and records the model and effort, the body passed through whole', async () => {
    const events: EgressEvent[] = []
    const gw = await startProxy(undefined, {
      modelResponses: [{ host: HOST, path: { exact: '/responses' }, method: ['POST'] }],
      onEvent: (e) => events.push(e),
    })
    try {
      gw.proxy.addTransformations([brokered])
      const r = await responses(gw)
      assert.equal(r.status, 200)
      assert.equal(r.headers['x-accept-encoding'], '', 'accept-encoding dropped upstream')
      assert.match(r.body, /"model":"gpt-5\.4-mini-2026-03-17".*data: \[DONE\]/s)
      const e = await requestEvent(events)
      assert.equal(e?.type === 'request' && e.responseModel, 'gpt-5.4-mini-2026-03-17')
      assert.equal(e?.type === 'request' && e.responseEffort, 'medium')
    } finally {
      gw.close()
    }
  })

  test('over HTTP/2 too', async () => {
    const events: EgressEvent[] = []
    const gw = await startProxy(undefined, {
      modelResponses: [{ host: HOST, path: { exact: '/responses' } }],
      onEvent: (e) => events.push(e),
    })
    try {
      gw.proxy.addTransformations([brokered])
      const r = await viaProxyH2(gw, HOST, h2.port, '/responses', `Bearer ${PLACEHOLDER}`)
      assert.equal(r.status, 200)
      const e = await requestEvent(events)
      assert.equal(e?.type === 'request' && e.responseModel, 'gpt-5.4-mini-2026-03-17')
    } finally {
      gw.close()
    }
  })

  test('twin: off the endpoints, the response is neither read nor its encoding changed', async () => {
    const events: EgressEvent[] = []
    const gw = await startProxy(undefined, {
      modelResponses: [{ host: HOST, path: { exact: '/v1/other' } }],
      onEvent: (e) => events.push(e),
    })
    try {
      gw.proxy.addTransformations([brokered])
      const r = await responses(gw)
      assert.equal(r.headers['x-accept-encoding'], 'gzip, br, zstd')
      const e = await requestEvent(events)
      assert.equal(e?.type, 'request')
      assert.equal(e?.type === 'request' && e.responseModel, undefined)
    } finally {
      gw.close()
    }
  })
})

describe('derived tokens through the proxy', () => {
  const derivedTokens = [
    {
      name: 'CURSOR_API_KEY',
      endpoint: { host: HOST, path: { startsWith: '/tokens/' }, method: ['POST'] },
      fields: ['accessToken', 'refreshToken'],
      hosts: [HOST],
    },
  ]
  let h1: { port: number; close(): void }
  let h2: { port: number; close(): void }
  let other: { port: number; close(): void }
  before(async () => {
    h1 = await startUpstream(HOST, false)
    h2 = await startUpstream(HOST, true)
    other = await startUpstream(OTHER, false)
  })
  after(() => {
    h1.close()
    h2.close()
    other.close()
  })
  const exchange = (gw: Gw, path = '/tokens/exchange') =>
    viaProxy(gw, HOST, h1.port, { method: 'POST', path, body: '{}' })
  const parts = (token: string) => token.split('.')

  test('the exchange response reaches the sandbox with placeholders that keep the real exp', async () => {
    const gw = await startProxy(undefined, { derivedTokens })
    try {
      const r = await exchange(gw)
      const body = JSON.parse(r.body) as Record<string, string>
      const access = body.accessToken ?? ''
      assert.doesNotMatch(r.body, /real-(access|refresh)-signature/)
      assert.match(access, /^[\w-]+\.[\w-]+\.reeval_secret_[0-9A-Za-z]{32}$/)
      assert.deepEqual(parts(access).slice(0, 2), parts(ACCESS).slice(0, 2), 'header and claims')
      assert.notEqual(body.refreshToken, access, 'one placeholder per token')
      assert.equal(body.kind, 'user', 'other fields untouched')
      assert.equal(Number(r.headers['content-length']), Buffer.byteLength(r.body))
      assert.ok(
        gw.lines.some((l) => l.includes('tokenised accessToken, refreshToken (CURSOR_API_KEY)')),
        gw.lines.join('\n'),
      )
      assert.doesNotMatch(gw.lines.join('\n'), /real-(access|refresh)-signature|reeval_secret_/)
    } finally {
      gw.close()
    }
    // Twin: without derived tokens, the same exchange hands the sandbox the real ones.
    const plain = await startProxy()
    try {
      plain.proxy.setSubstitutions([
        {
          name: 'X',
          placeholder: 'reeval_secret_x',
          value: 'x-value',
          hosts: [HOST],
          in: ['header'],
        },
      ])
      assert.match((await exchange(plain)).body, /real-access-signature/)
    } finally {
      plain.close()
    }
  })

  test('over HTTP/2 too', async () => {
    const gw = await startProxy(undefined, { derivedTokens })
    try {
      const r = await viaProxyH2(gw, HOST, h2.port, '/tokens/exchange')
      const { accessToken } = JSON.parse(r.body) as { accessToken: string }
      assert.match(accessToken, /\.reeval_secret_[0-9A-Za-z]{32}$/)
      assert.doesNotMatch(r.body, /real-access-signature/)
    } finally {
      gw.close()
    }
  })

  test('token placeholders get the real token on the token hosts only, over HTTP/1.1 and HTTP/2', async () => {
    const gw = await startProxy(undefined, { derivedTokens })
    try {
      const { accessToken } = JSON.parse((await exchange(gw)).body) as { accessToken: string }
      gw.proxy.setSubstitutions([])
      seen.length = 0
      const r = await viaProxy(gw, HOST, h1.port, {
        path: '/echo',
        headers: { authorization: `Bearer ${accessToken}` },
      })
      assert.equal(seen[0]?.headers.authorization, `Bearer ${ACCESS}`, 'kept by setSubstitutions')
      assert.equal(r.headers['x-echo-authorization'], `Bearer ${accessToken}`, 'headers scrubbed')
      await viaProxyH2(gw, HOST, h2.port, '/echo', `Bearer ${accessToken}`)
      assert.equal(seen[1]?.headers.authorization, `Bearer ${ACCESS}`)
      // Twin: another host is tunnelled blind, so nothing there could swap the token in.
      await assert.rejects(
        viaProxy(gw, OTHER, other.port, {
          path: '/echo',
          headers: { authorization: `Bearer ${accessToken}` },
        }),
        /self-signed|unable to verify|certificate/i,
      )
      assert.equal(seen.length, 2)
    } finally {
      gw.close()
    }
  })

  test('a failed exchange passes through; an unreadable success is a 502 without the tokens', async () => {
    const gw = await startProxy(undefined, { derivedTokens })
    try {
      const denied = await exchange(gw, '/tokens/denied')
      assert.equal(denied.status, 401)
      assert.equal(denied.body, '{"error":"unauthorized","auth":""}')
      const garbled = await exchange(gw, '/tokens/garbled')
      assert.equal(garbled.status, 502)
      assert.match(garbled.body, /couldn't keep CURSOR_API_KEY's tokens out of the sandbox/)
      assert.doesNotMatch(garbled.body, /real-access-signature/)
      const gzipped = await exchange(gw, '/tokens/gzip')
      assert.equal(gzipped.status, 502)
      assert.match(gzipped.body, /the response is gzip-encoded/)
    } finally {
      gw.close()
    }
  })

  test('the brokered key is scrubbed from the exchange response, as from any other', async () => {
    const gw = await startProxy(undefined, { derivedTokens })
    try {
      const key = { name: 'CURSOR_API_KEY', placeholder: 'reeval_secret_key', value: REAL }
      gw.proxy.setSubstitutions([{ ...key, hosts: [HOST], in: ['header'] }])
      const headers = { authorization: `Bearer ${key.placeholder}` }
      for (const path of ['/tokens/echo', '/tokens/denied']) {
        const r = await viaProxy(gw, HOST, h1.port, { method: 'POST', path, body: '{}', headers })
        assert.equal(seen.at(-1)?.headers.authorization, `Bearer ${REAL}`, path)
        assert.equal(JSON.parse(r.body).auth, `Bearer ${key.placeholder}`, path)
      }
    } finally {
      gw.close()
    }
  })
})
