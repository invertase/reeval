import assert from 'node:assert/strict'
import { X509Certificate } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Duplex, PassThrough } from 'node:stream'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createCertificateAuthority, issueServerCertificate } from '../src/egress/cert.ts'
import { createMux, forwarderScript, link } from '../src/egress/mux.ts'
import { createPolicyCheck, DEFAULT_ALLOWED_HOSTS, hostAllowed } from '../src/egress/policy.ts'
import {
  applyTransformations,
  decrypts,
  matches,
  type OutboundRequest,
  type RequestTransformation,
} from '../src/egress/rules.ts'
import { HARNESS_CURSOR_VERSION } from '../src/image.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const PLACEHOLDER = `aisdkhc_${'A'.repeat(43)}`
const REAL = 'crsr_real_key_for_tests_0123456789'

/** The rule `@ai-sdk/harness-cursor` asks for. */
const cursorRule: RequestTransformation = {
  match: {
    host: 'api2.cursor.sh',
    path: { exact: '/auth/exchange_user_api_key' },
    method: ['POST'],
    headers: [{ key: { exact: 'Authorization' }, value: { exact: `Bearer ${PLACEHOLDER}` } }],
  },
  transform: { headers: { Authorization: `Bearer ${REAL}` } },
}

const request = (over: Partial<OutboundRequest> = {}): OutboundRequest => ({
  host: 'api2.cursor.sh',
  method: 'POST',
  path: '/auth/exchange_user_api_key',
  headers: { authorization: `Bearer ${PLACEHOLDER}`, 'content-type': 'application/json' },
  ...over,
})

describe('request transformations', () => {
  test('the Cursor exchange request gets the real key', () => {
    const { headers, replaced } = applyTransformations([cursorRule], request())
    assert.equal(headers.authorization, `Bearer ${REAL}`)
    assert.equal(headers['content-type'], 'application/json')
    assert.deepEqual(replaced, ['authorization'])
  })

  test('host, path, method and header value must all match', () => {
    const misses: Partial<OutboundRequest>[] = [
      { host: 'api3.cursor.sh' },
      { host: 'evil.example' },
      { path: '/auth/exchange_user_api_key/extra' },
      { path: '/other' },
      { method: 'GET' },
      { headers: { authorization: 'Bearer something-else' } },
      { headers: {} },
    ]
    for (const miss of misses) {
      assert.equal(matches(cursorRule, request(miss)), false, JSON.stringify(miss))
      const { headers } = applyTransformations([cursorRule], request(miss))
      assert.doesNotMatch(JSON.stringify(headers), new RegExp(REAL), JSON.stringify(miss))
    }
  })

  test('host and header names ignore case; the query string is not part of the path', () => {
    assert.ok(matches(cursorRule, request({ host: 'API2.Cursor.SH.' })))
    assert.ok(matches(cursorRule, request({ method: 'post' })))
    assert.ok(matches(cursorRule, request({ path: '/auth/exchange_user_api_key?x=1' })))
    const upper = { match: { ...cursorRule.match, headers: [{ key: { exact: 'AUTHORIZATION' } }] } }
    assert.ok(matches({ ...cursorRule, ...upper }, request()))
  })

  test('startsWith and regex paths, query and header matchers', () => {
    const rule: RequestTransformation = {
      match: {
        host: 'api.example.com',
        path: { startsWith: '/v1/' },
        queryString: [{ key: { exact: 'key' }, value: { regex: '^ph_' } }],
        headers: [{ key: { startsWith: 'x-ES' } }],
      },
      transform: { headers: { 'X-Api-Key': 'real' } },
    }
    const base = { host: 'api.example.com', method: 'GET', headers: { 'x-es-client': '1' } }
    assert.ok(matches(rule, { ...base, path: '/v1/models?key=ph_1' }))
    assert.equal(matches(rule, { ...base, path: '/v2/models?key=ph_1' }), false)
    assert.equal(matches(rule, { ...base, path: '/v1/models?key=real' }), false)
    assert.equal(matches(rule, { ...base, path: '/v1/models' }), false)
    assert.equal(matches(rule, { ...base, headers: {}, path: '/v1/models?key=ph_1' }), false)
    const regex = { ...rule, match: { host: 'api.example.com', path: { regex: '^/v[0-9]+/x$' } } }
    assert.ok(matches(regex, { ...base, path: '/v12/x' }))
    assert.equal(matches(regex, { ...base, path: '/v12/xy' }), false)
  })

  test('later rules win; a multi-valued header matches on any value', () => {
    const second = { ...cursorRule, transform: { headers: { authorization: 'Bearer second' } } }
    const { headers } = applyTransformations([cursorRule, second], request())
    assert.equal(headers.authorization, 'Bearer second')
    const multi = request({ headers: { authorization: ['x', `Bearer ${PLACEHOLDER}`] } })
    assert.ok(matches(cursorRule, multi))
  })

  test('only hosts with a rule are decrypted', () => {
    assert.ok(decrypts([cursorRule], 'api2.cursor.sh'))
    assert.ok(decrypts([cursorRule], 'API2.CURSOR.SH'))
    assert.equal(decrypts([cursorRule], 'agentn.global.api5.cursor.sh'), false)
    assert.equal(decrypts([], 'api2.cursor.sh'), false)
  })
})

describe('network policy', () => {
  const lookup = async (host: string) =>
    ({
      'github.com': ['140.82.112.3'],
      'internal.corp': ['10.1.2.3'],
      'metadata.cloud': ['169.254.169.254'],
      'sneaky.example': ['127.0.0.1'],
      'mixed.example': ['10.1.2.3', '8.8.8.8'],
    })[host] ?? ['93.184.216.34']

  test('wildcards match subdomains only', () => {
    assert.ok(hostAllowed(['*.cursor.sh'], 'agentn.global.api5.cursor.sh'))
    assert.equal(hostAllowed(['*.cursor.sh'], 'cursor.sh'), false)
    assert.equal(hostAllowed(['*.cursor.sh'], 'evilcursor.sh'), false)
    assert.ok(hostAllowed(['GitHub.com'], 'github.com.'))
    assert.ok(hostAllowed(DEFAULT_ALLOWED_HOSTS, 'raw.githubusercontent.com'))
  })

  test('allow-all allows anything but loopback and link-local', async () => {
    const check = createPolicyCheck({ mode: 'allow-all' }, { lookup })
    assert.deepEqual(await check('example.com'), { allowed: true, address: '93.184.216.34' })
    assert.equal((await check('sneaky.example')).allowed, false)
    assert.equal((await check('metadata.cloud')).allowed, false)
    assert.equal((await check('127.0.0.1')).allowed, false)
    assert.equal((await check('[::1]')).allowed, false)
    const loose = createPolicyCheck({ mode: 'allow-all' }, { lookup, allowLoopback: true })
    assert.equal((await loose('sneaky.example')).allowed, true)
  })

  test('deny-all denies everything', async () => {
    const check = createPolicyCheck({ mode: 'deny-all' }, { lookup })
    const verdict = await check('api2.cursor.sh')
    assert.equal(verdict.allowed, false)
    assert.equal(!verdict.allowed && verdict.status, 403)
  })

  test('custom: hosts, CIDRs, and denied CIDRs that win', async () => {
    const check = createPolicyCheck(
      {
        mode: 'custom',
        allowedHosts: ['github.com', '*.cursor.sh', 'internal.corp'],
        allowedCIDRs: ['8.8.8.0/24'],
        deniedCIDRs: ['10.0.0.0/8'],
      },
      { lookup },
    )
    assert.equal((await check('github.com')).allowed, true)
    assert.equal((await check('api2.cursor.sh')).allowed, true)
    assert.equal((await check('example.com')).allowed, false)
    assert.equal((await check('8.8.8.8')).allowed, true)
    assert.equal((await check('internal.corp')).allowed, false, 'denied CIDRs beat allowed hosts')
    assert.equal((await check('mixed.example')).allowed, false)
    const verdict = await check('example.com')
    assert.match(!verdict.allowed ? verdict.reason : '', /isn't in the allowlist/)
  })

  test('an unresolvable host is a 502, not a silent allow', async () => {
    const check = createPolicyCheck(
      { mode: 'allow-all' },
      {
        lookup: async () => {
          throw new Error('ENOTFOUND')
        },
      },
    )
    const verdict = await check('nope.invalid')
    assert.equal(!verdict.allowed && verdict.status, 502)
  })
})

describe('certificates', () => {
  test('the CA signs leaf certificates for names and addresses', () => {
    const ca = createCertificateAuthority()
    const caCert = new X509Certificate(ca.cert)
    assert.ok(caCert.ca)
    assert.ok(caCert.verify(caCert.publicKey))
    for (const host of ['api2.cursor.sh', '127.0.0.1', '::1']) {
      const leaf = new X509Certificate(issueServerCertificate(ca, host).cert)
      assert.ok(leaf.verify(caCert.publicKey), host)
      assert.ok(leaf.checkIssued(caCert), host)
      assert.equal(leaf.ca, false)
      assert.ok(host.includes('.') && !/^\d/.test(host) ? leaf.checkHost(host) : leaf.checkIP(host))
    }
    const leaf = new X509Certificate(issueServerCertificate(ca, 'api2.cursor.sh').cert)
    assert.equal(leaf.checkHost('evil.example'), undefined)
    assert.ok(new Date(leaf.validTo).getTime() > Date.now() + 6 * 86_400_000)
  })

  test('two CAs never trust each other', () => {
    const a = createCertificateAuthority()
    const b = createCertificateAuthority()
    const leaf = new X509Certificate(issueServerCertificate(a, 'x.example').cert)
    assert.equal(leaf.verify(new X509Certificate(b.cert).publicKey), false)
  })
})

/** Two muxes wired back to back, as the host and the forwarder are over docker exec stdio. */
function muxPair(window?: number) {
  const opened: { stream: Duplex; port: number }[] = []
  let host: ReturnType<typeof createMux>
  let container: ReturnType<typeof createMux>
  let wire = 0
  host = createMux({
    Duplex,
    parity: 0,
    window,
    send: (f) => {
      wire += f.length
      setImmediate(() => container.receive(f))
    },
    onOpen: (stream, port) => opened.push({ stream, port }),
  })
  container = createMux({
    Duplex,
    parity: 1,
    window,
    send: (f) => setImmediate(() => host.receive(f)),
    onOpen: (stream, port) => opened.push({ stream, port }),
  })
  return { host, container, opened, wire: () => wire }
}

const collect = (s: Duplex) =>
  new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    s.on('data', (c: Buffer) => chunks.push(c))
    s.on('end', () => resolve(Buffer.concat(chunks)))
    s.on('error', reject)
  })

describe('stdio mux', () => {
  test('streams in both directions carry bytes intact, with half-close', async () => {
    const { host, container, opened } = muxPair()
    const a = host.open(43210)
    const b = container.open(43128)
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    assert.deepEqual(
      opened.map((o) => o.port),
      [43210, 43128],
    )
    const [aPeer, bPeer] = opened.map((o) => o.stream) as [Duplex, Duplex]
    const payload = Buffer.alloc(3 * 1024 * 1024 + 7, 'x')
    const got = collect(aPeer)
    a.end(payload)
    assert.ok((await got).equals(payload))
    // The other direction still works after one side ended.
    const back = collect(a)
    aPeer.end('reply')
    assert.equal((await back).toString(), 'reply')
    const got2 = collect(b)
    bPeer.end('hello')
    assert.equal((await got2).toString(), 'hello')
  })

  test('a slow reader holds back its sender instead of buffering everything', async () => {
    const { host, opened, wire } = muxPair(64 * 1024)
    const a = host.open(1)
    await new Promise((r) => setTimeout(r, 5))
    const peer = opened[0]?.stream as Duplex
    peer.pause()
    let writes = 0
    const pump = async () => {
      for (let i = 0; i < 100; i++) {
        if (!a.write(Buffer.alloc(16 * 1024))) await new Promise((r) => a.once('drain', r))
        writes++
      }
      a.end()
    }
    void pump()
    await new Promise((r) => setTimeout(r, 100))
    assert.ok(wire() < 200 * 1024, `sent ${wire()} bytes to a paused reader`)
    assert.ok(writes < 100)
    const all = collect(peer)
    peer.resume()
    assert.equal((await all).length, 100 * 16 * 1024)
  })

  test('destroying one side resets the peer stream', async () => {
    const { host, opened } = muxPair()
    const a = host.open(1)
    await new Promise((r) => setTimeout(r, 5))
    const peer = opened[0]?.stream as Duplex
    const closed = new Promise((r) => peer.once('close', r))
    a.destroy()
    await closed
    assert.equal(peer.destroyed, true)
  })

  test('link() half-closes on a clean end and tears both down on errors', async () => {
    const a = new PassThrough()
    const b = new PassThrough()
    const pair = Duplex.from({ readable: a, writable: b })
    const other = new PassThrough()
    link(pair, other)
    const broken = new Promise((r) => other.once('close', r))
    pair.destroy(new Error('boom'))
    await broken
    assert.equal(other.destroyed, true)
  })

  test('the forwarder script is self-contained JavaScript', () => {
    const script = forwarderScript(43128)
    assert.doesNotThrow(() => new Function('require', 'process', script))
    assert.doesNotMatch(script, /\bimport\b|\bexport\b/)
  })
})

describe('package boundary', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
    )

  test('imports only Node built-ins, @ai-sdk harness packages and its own files', () => {
    for (const file of files(join(root, 'src'))) {
      const source = readFileSync(file, 'utf8')
      for (const [, spec] of source.matchAll(/from '([^']+)'/g)) {
        assert.match(
          spec ?? '',
          /^(node:|\.\.?\/|@ai-sdk\/harness(-cursor)?(\/|$))/,
          `${file} imports ${spec}`,
        )
      }
    }
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    assert.equal(pkg.dependencies.evalsuite, undefined)
  })

  test('ships the Docker build context and pins the harness adapter', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    assert.ok(pkg.files.includes('docker'))
    assert.match(readFileSync(join(root, 'docker/Dockerfile'), 'utf8'), /^FROM node:/m)
    assert.equal(pkg.dependencies['@ai-sdk/harness-cursor'], HARNESS_CURSOR_VERSION)
  })
})
