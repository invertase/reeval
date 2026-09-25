import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import http from 'node:http'
import http2 from 'node:http2'
import https from 'node:https'
import net from 'node:net'
import { after, before, describe, test } from 'node:test'
import tls from 'node:tls'
import { createCertificateAuthority, issueServerCertificate } from '../src/egress/cert.ts'
import type { NetworkPolicy } from '../src/egress/policy.ts'
import { createEgressProxy, type EgressProxy } from '../src/egress/proxy.ts'
import type { RequestTransformation } from '../src/egress/rules.ts'

const PLACEHOLDER = `aisdkhc_${'P'.repeat(43)}`
const REAL = 'crsr_real_integration_key_0123456789abcdef'
const HOST = 'api.upstream.test'
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
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`,
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
async function startProxy(policy: NetworkPolicy = { mode: 'allow-all' }) {
  const ca = createCertificateAuthority()
  const lines: string[] = []
  const proxy = createEgressProxy({
    ca,
    policy,
    log: (l) => {
      lines.push(l)
      if (process.env.DBG) console.error(l)
    },
    upstreamCA: upstreamCa.cert,
    lookup: async (host) => (host.endsWith('.test') ? ['127.0.0.1'] : ['203.0.113.1']),
    allowLoopback: true,
  })
  const server = net.createServer((s) => proxy.handle(s))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    proxy,
    ca,
    lines,
    port: (server.address() as net.AddressInfo).port,
    close() {
      proxy.close()
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
async function viaProxyH2(gw: Gw, host: string, port: number, path: string, auth: string) {
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
      assert.match(!r.ok ? r.body : '', /blocked by the ES egress policy/)
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

  test('the host loopback stays out of reach by default', async () => {
    const ca = createCertificateAuthority()
    const proxy: EgressProxy = createEgressProxy({ ca, policy: { mode: 'allow-all' } })
    const server = net.createServer((s) => proxy.handle(s))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    try {
      const gw = { port: (server.address() as net.AddressInfo).port } as Gw
      for (const host of ['127.0.0.1', 'localhost', '[::1]', '[::]', '169.254.169.254']) {
        const r = await connect(gw, host, h1.port)
        assert.equal(!r.ok && r.status, 403, host)
      }
    } finally {
      proxy.close()
      server.close()
    }
  })
})
