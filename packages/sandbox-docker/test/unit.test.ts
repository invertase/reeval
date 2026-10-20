import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { Duplex, PassThrough } from 'node:stream'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  contextFiles,
  dockerfileTag,
  dockerignoreMatcher,
  installLayerTag,
  installScript,
} from '../src/build-image.ts'
import { dockerState, imageInfo, isRegistryDigest } from '../src/docker-cli.ts'
import { createCertificateAuthority, issueServerCertificate } from '../src/egress/cert.ts'
import { createMux, forwarderScript, link } from '../src/egress/mux.ts'
import { createPolicyCheck, defaultAllowedHosts, hostAllowed } from '../src/egress/policy.ts'
import {
  applyTransformations,
  decrypts,
  type EndpointMatch,
  matches,
  type OutboundRequest,
  type RequestTransformation,
} from '../src/egress/rules.ts'
import { dockerSeccompFile, ENGINES, normalizeImageId } from '../src/engine.ts'
import { DEFAULT_IMAGE, HARNESS_PACKAGES, harnessLabel, imageFor } from '../src/image.ts'
import { memorySwap } from '../src/session.ts'
import { type DockerCommand, onDockerCommand, traceDocker } from '../src/trace.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const PLACEHOLDER = `aisdkhc_${'A'.repeat(43)}`
const REAL = 'crsr_real_key_for_tests_0123456789'

/** The rule the Cursor adapter asks for. */
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

test("dockerState: running, down, or Windows containers, from the CLI's own answer", async () => {
  // A docker CLI that answers `info` with $FAKE_DOCKER_INFO, or fails without it; a Node script
  // behind an sh and a .cmd wrapper, so it runs on every OS.
  const bin = mkdtempSync(join(tmpdir(), 'reeval-docker-state-'))
  writeFileSync(
    join(bin, 'docker.js'),
    'const out = process.env.FAKE_DOCKER_INFO; if (out === undefined) process.exit(1); console.log(out)\n',
  )
  writeFileSync(join(bin, 'docker'), `#!/bin/sh\nexec node "$(dirname "$0")/docker.js" "$@"\n`)
  chmodSync(join(bin, 'docker'), 0o755)
  writeFileSync(join(bin, 'docker.cmd'), '@node "%~dp0docker.js" %*\r\n')
  const path = process.env.PATH
  process.env.PATH = `${bin}${delimiter}${path}`
  const state = async (info: string | undefined) => {
    if (info === undefined) delete process.env.FAKE_DOCKER_INFO
    else process.env.FAKE_DOCKER_INFO = info
    return dockerState()
  }
  try {
    assert.equal(await state('29.1.0 linux'), 'running')
    assert.equal(await state('29.1.0 windows'), 'windows-containers')
    assert.equal(await state(undefined), 'down', 'no daemon')
    assert.equal(await state(''), 'down', 'a CLI that exits 0 without a daemon prints no version')
  } finally {
    process.env.PATH = path
    delete process.env.FAKE_DOCKER_INFO
  }
})

test('imageInfo without a docker CLI at all is no image, not a spawn error', async () => {
  const path = process.env.PATH
  process.env.PATH = mkdtempSync(join(tmpdir(), 'reeval-no-docker-'))
  try {
    assert.equal(await imageInfo('reeval-sandbox:cursor-0.1.0'), null)
  } finally {
    process.env.PATH = path
  }
})

test('--memory-swap is memory plus swap: as much again by default, memory alone at swap 0', () => {
  assert.equal(memorySwap({ memory: '4g' }), '8g')
  assert.equal(memorySwap({ memory: '4g', swap: '2g' }), '6g')
  assert.equal(memorySwap({ memory: '4g', swap: 0 }), '4g')
  assert.equal(memorySwap({ memory: '4g', swap: '0' }), '4g')
  assert.equal(memorySwap({ memory: '512M', swap: '1g' }), '1536m')
  assert.equal(memorySwap({ memory: '1.5g' }), '3g')
  assert.equal(memorySwap({ memory: 1000, swap: 24 }), '1k')
  assert.equal(memorySwap({ memory: 1000 }), '2000')
})

describe('request transformations', () => {
  test('the Cursor exchange request gets the real key', () => {
    const { headers, replaced } = applyTransformations([cursorRule], request())
    assert.equal(headers.authorization, `Bearer ${REAL}`)
    assert.equal(headers['content-type'], 'application/json')
    assert.deepEqual(replaced, ['authorization'])
  })

  test('with endpoints, a host-wide rule only keys requests on them, and refuses the rest', () => {
    const hostWide: RequestTransformation = {
      match: {
        host: 'api.anthropic.com',
        headers: [{ key: { exact: 'x-api-key' }, value: { exact: PLACEHOLDER } }],
      },
      transform: { headers: { 'x-api-key': REAL } },
    }
    const endpoints: EndpointMatch[] = [
      { host: 'api.anthropic.com', path: { exact: '/v1/messages' }, method: ['POST'] },
      { host: 'api.anthropic.com', path: { regex: '^/api/eval/sdk-[A-Za-z0-9_-]+$' } },
    ]
    const call = (method: string, path: string, key = PLACEHOLDER) =>
      applyTransformations(
        [hostWide],
        { host: 'api.anthropic.com', method, path, headers: { 'x-api-key': key } },
        endpoints,
      )
    const keyed = call('POST', '/v1/messages?beta=true')
    assert.equal(keyed.headers['x-api-key'], REAL)
    assert.equal(keyed.refused, false)
    assert.equal(call('GET', '/api/eval/sdk-abc123').headers['x-api-key'], REAL, 'any method')
    const misses: Array<[string, string]> = [
      ['GET', '/v1/messages'],
      ['POST', '/v1/messages/batches'],
      ['POST', '/v1/files'],
      ['GET', '/v1/models'],
      ['POST', '/api/eval/sdk-abc/../../v1/files'],
    ]
    for (const [method, path] of misses) {
      const r = call(method, path)
      assert.equal(r.refused, true, `${method} ${path}`)
      assert.deepEqual(r.replaced, [], `${method} ${path}`)
      assert.doesNotMatch(JSON.stringify(r.headers), new RegExp(REAL), `${method} ${path}`)
    }
    const unbrokered = call('GET', '/v1/models', 'sk-someone-else')
    assert.equal(unbrokered.refused, false, 'no rule applies, so it is not ours to refuse')
    assert.equal(unbrokered.headers['x-api-key'], 'sk-someone-else')
    const open = applyTransformations([hostWide], {
      host: 'api.anthropic.com',
      method: 'GET',
      path: '/v1/models',
      headers: { 'x-api-key': PLACEHOLDER },
    })
    assert.equal(open.headers['x-api-key'], REAL, 'without endpoints, the rule alone decides')
    const tagging: RequestTransformation = {
      match: { host: 'api.anthropic.com' },
      transform: { headers: { 'x-tag': 'reeval' } },
    }
    const tagged = applyTransformations(
      [tagging],
      { host: 'api.anthropic.com', method: 'GET', path: '/v1/models', headers: {} },
      endpoints,
    )
    assert.equal(tagged.refused, false, 'a rule with no placeholder to key on refuses nothing')
    assert.equal(tagged.headers['x-tag'], undefined, 'and it does not apply off the endpoints')
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
        headers: [{ key: { startsWith: 'x-reeval' } }],
      },
      transform: { headers: { 'X-Api-Key': 'real' } },
    }
    const base = { host: 'api.example.com', method: 'GET', headers: { 'x-reeval-client': '1' } }
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
    assert.ok(hostAllowed(defaultAllowedHosts('cursor'), 'raw.githubusercontent.com'))
  })

  test('a wildcard never matches an IP address, in any form', () => {
    for (const host of ['10.1.2.3', '1.2.3', '[::ffff:10.1.2.3]', '[fd00::1.2.3]']) {
      assert.equal(hostAllowed(['*.2.3', '*.1.2.3', '*.3'], host), false, host)
    }
    // Twin: an address listed as it is matches.
    assert.ok(hostAllowed(['10.1.2.3'], '10.1.2.3'))
  })

  test('a name only a wildcard matches may not resolve to a private address', async () => {
    const rebound = async (host: string) =>
      host.endsWith('.rebind.example') ? [host.startsWith('v6') ? 'fd00::1' : '10.0.0.5'] : []
    const check = createPolicyCheck(
      { mode: 'custom', allowedHosts: ['*.rebind.example', 'intranet.rebind.example'] },
      { lookup: rebound },
    )
    for (const host of ['a.rebind.example', 'v6.rebind.example']) {
      const verdict = await check(host)
      assert.equal(verdict.allowed, false, host)
      assert.match(!verdict.allowed ? verdict.reason : '', /private address/)
    }
    // Twin: a host listed by name is trusted to resolve where it does.
    assert.deepEqual(await check('intranet.rebind.example'), {
      allowed: true,
      address: '10.0.0.5',
    })
  })

  test("each harness's default allowlist has its own hosts and not the others'", () => {
    const cursor = defaultAllowedHosts('cursor')
    const claude = defaultAllowedHosts('claude-code')
    const antigravity = defaultAllowedHosts('antigravity')
    assert.ok(hostAllowed(antigravity, 'generativelanguage.googleapis.com'))
    assert.equal(hostAllowed(antigravity, 'cloudcode-pa.googleapis.com'), false)
    assert.equal(hostAllowed(antigravity, 'api.anthropic.com'), false)
    assert.equal(hostAllowed(cursor, 'generativelanguage.googleapis.com'), false)
    assert.ok(hostAllowed(cursor, 'api2.cursor.sh'))
    assert.ok(hostAllowed(claude, 'api.anthropic.com'))
    assert.equal(hostAllowed(cursor, 'api.anthropic.com'), false)
    assert.equal(hostAllowed(claude, 'api2.cursor.sh'), false)
    assert.equal(hostAllowed(claude, 'anthropic.com.evil.example'), false)
    for (const hosts of [cursor, claude, antigravity]) {
      assert.ok(hostAllowed(hosts, 'registry.npmjs.org'))
    }
  })

  test('allow-all allows anything but loopback and link-local', async () => {
    const check = createPolicyCheck({ mode: 'allow-all' }, { lookup })
    assert.deepEqual(await check('example.com'), { allowed: true, address: '93.184.216.34' })
    assert.equal((await check('sneaky.example')).allowed, false)
    assert.equal((await check('metadata.cloud')).allowed, false)
    assert.equal((await check('127.0.0.1')).allowed, false)
    assert.equal((await check('[::1]')).allowed, false)
    // Connecting to the unspecified address reaches the local host, like 0.0.0.0.
    for (const host of [
      '[::]',
      '::',
      '0:0:0:0:0:0:0:0',
      '::ffff:127.0.0.1',
      '::ffff:169.254.169.254',
    ]) {
      assert.equal((await check(host)).allowed, false, host)
    }
    const loose = createPolicyCheck({ mode: 'allow-all' }, { lookup, allowLoopback: true })
    assert.equal((await loose('sneaky.example')).allowed, true)
  })

  test('deny list: every always-denied form, under every policy', async () => {
    const DENIED = [
      '127.0.0.1',
      '127.1.2.3',
      'localhost',
      '0.0.0.0',
      '[::]',
      '[::1]',
      '[::ffff:127.0.0.1]',
      '169.254.169.254',
      '[fe80::1]',
      'six.loopback.test',
    ]
    const resolve = async (host: string) =>
      host === 'localhost' ? ['127.0.0.1'] : host === 'six.loopback.test' ? ['::1'] : lookup(host)
    const policies = [{ mode: 'allow-all' }, { mode: 'custom', allowedHosts: DENIED }] as const
    for (const policy of policies) {
      const check = createPolicyCheck(policy, { lookup: resolve })
      for (const host of DENIED) {
        const verdict = await check(host)
        assert.equal(verdict.allowed, false, `${policy.mode}: ${host}`)
        assert.match(!verdict.allowed ? verdict.reason : '', /loopback or link-local/, host)
      }
      // Twin: with allowLoopback (every Docker test sets it), the same table goes through.
      const loose = createPolicyCheck(policy, { lookup: resolve, allowLoopback: true })
      for (const host of DENIED) assert.equal((await loose(host)).allowed, true, host)
    }
  })

  test('an unlisted host is refused before any DNS lookup', async () => {
    const asked: string[] = []
    const counting = async (host: string) => {
      asked.push(host)
      return lookup(host)
    }
    const check = createPolicyCheck(
      { mode: 'custom', allowedHosts: ['github.com'] },
      { lookup: counting },
    )
    const verdict = await check('unresolvable.invalid')
    assert.deepEqual(verdict, {
      allowed: false,
      status: 403,
      reason: "unresolvable.invalid isn't in the allowlist",
    })
    assert.deepEqual(asked, [])
    // Twin: a listed host is looked up, and so is any host when the policy allows CIDRs.
    assert.equal((await check('github.com')).allowed, true)
    const cidrs = createPolicyCheck(
      { mode: 'custom', allowedCIDRs: ['10.0.0.0/8'] },
      { lookup: counting },
    )
    assert.equal((await cidrs('internal.corp')).allowed, true)
    assert.deepEqual(asked, ['github.com', 'internal.corp'])
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
  const waiting: ((stream: Duplex) => void)[] = []
  const onOpen = (stream: Duplex, port: number) => {
    opened.push({ stream, port })
    waiting.shift()?.(stream)
  }
  /** The next stream the far side opens: frames arrive on a later tick, not after a set delay. */
  const peer = () => new Promise<Duplex>((resolve) => waiting.push(resolve))
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
    onOpen,
  })
  container = createMux({
    Duplex,
    parity: 1,
    window,
    send: (f) => setImmediate(() => host.receive(f)),
    onOpen,
  })
  return { host, container, opened, peer, wire: () => wire }
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
    const pair = muxPair(64 * 1024)
    const opening = pair.peer()
    const a = pair.host.open(1)
    const peer = await opening
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
    assert.ok(pair.wire() < 200 * 1024, `sent ${pair.wire()} bytes to a paused reader`)
    assert.ok(writes < 100)
    const all = collect(peer)
    peer.resume()
    assert.equal((await all).length, 100 * 16 * 1024)
  })

  test('destroying one side resets the peer stream', async () => {
    const pair = muxPair()
    const opening = pair.peer()
    const a = pair.host.open(1)
    const peer = await opening
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

test('only registry-qualified or namespaced digests count as pushed', () => {
  const d = `@sha256:${'a'.repeat(64)}`
  // What the containerd image store reports for images built on this machine.
  assert.equal(isRegistryDigest(`reeval-sandbox${d}`), false)
  assert.equal(isRegistryDigest(`reeval-env${d}`), false)
  assert.equal(isRegistryDigest(`busybox${d}`), false)
  assert.equal(isRegistryDigest(`invertase/reeval-sandbox${d}`), true)
  assert.equal(isRegistryDigest(`ghcr.io/invertase/reeval${d}`), true)
  assert.equal(isRegistryDigest(`localhost:5000/reeval${d}`), true)
  // Podman's local images are `localhost/<name>`: no registry anyone pulls from.
  assert.equal(isRegistryDigest(`localhost/reeval-sandbox${d}`), false)
})

describe('engines', () => {
  test("podman runs every container on the bridge with Docker's seccomp profile; docker adds nothing", () => {
    assert.deepEqual(ENGINES.docker.runArgs(), [])
    const [network, bridge, opt, seccomp] = ENGINES.podman.runArgs()
    assert.deepEqual([network, bridge, opt], ['--network', 'bridge', '--security-opt'])
    const file = (seccomp ?? '').replace(/^seccomp=/, '')
    const profile = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(profile.defaultAction, 'SCMP_ACT_ERRNO')
    // Canary: Docker's profile allows unshare only with CAP_SYS_ADMIN, which sandboxes never have.
    const unshare = profile.syscalls.filter((s: { names: string[] }) => s.names.includes('unshare'))
    assert.ok(unshare.length > 0)
    for (const rule of unshare) assert.deepEqual(rule.includes?.caps, ['CAP_SYS_ADMIN'])
    assert.equal(dockerSeccompFile(), file, 'written once')
  })

  test('image ids read the same on both: sha256:<hex>', () => {
    assert.equal(normalizeImageId('aaef90e0'), 'sha256:aaef90e0')
    assert.equal(normalizeImageId('sha256:aaef90e0'), 'sha256:aaef90e0')
  })

  test('podman removes without the grace period; docker as before', () => {
    assert.deepEqual(ENGINES.podman.rmForce, ['rm', '-f', '--time', '0'])
    assert.deepEqual(ENGINES.docker.rmForce, ['rm', '-f'])
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
          /^(node:|\.\.?\/|@ai-sdk\/harness(-cursor|-claude-code)?(\/|$))/,
          `${file} imports ${spec}`,
        )
      }
    }
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    assert.equal(pkg.dependencies.reeval, undefined)
  })

  test('ships the Docker build context and pins every harness adapter', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    assert.ok(pkg.files.includes('docker'))
    assert.match(readFileSync(join(root, 'docker/Dockerfile'), 'utf8'), /^FROM node:/m)
    for (const { name, version } of Object.values(HARNESS_PACKAGES)) {
      const expected = name.startsWith('@reeval/') ? `workspace:${version}` : version
      assert.equal(pkg.dependencies[name], expected, name)
    }
  })

  test('each harness has its own image, tagged and labelled with its adapter version', () => {
    const { cursor, 'claude-code': claude } = HARNESS_PACKAGES
    assert.equal(imageFor('cursor'), `reeval-sandbox:cursor-${cursor.version}`)
    assert.equal(
      imageFor('claude-code'),
      `reeval-sandbox:claude-code-${claude.version}-patch.${claude.patch}`,
    )
    assert.equal(DEFAULT_IMAGE, imageFor('cursor'))
    assert.equal(
      harnessLabel('claude-code'),
      `@ai-sdk/harness-claude-code@${claude.version}-patch.${claude.patch}`,
    )
    assert.equal(
      imageFor('antigravity'),
      `reeval-sandbox:antigravity-${HARNESS_PACKAGES.antigravity.version}`,
    )
  })

  test("a patched adapter's image is tagged with its patch, and only a patched one", () => {
    // The bootstrap bakes the patched bridge, so a changed patch must change the tag.
    const workspace = join(root, '../..')
    const patched = new Map(
      [
        ...readFileSync(join(workspace, 'pnpm-workspace.yaml'), 'utf8').matchAll(
          /^ {2}'?(@?[^@'\s]+)@([^':\s]+)'?: (\S+)$/gm,
        ),
      ].map(([, name, version, file]) => [`${name}@${version}`, file as string]),
    )
    for (const { name, version, patch } of Object.values(HARNESS_PACKAGES)) {
      const file = patched.get(`${name}@${version}`)
      if (!file) {
        assert.equal(patch, undefined, `${name} has a patch but no patchedDependencies entry`)
        continue
      }
      const sha = createHash('sha256')
        .update(readFileSync(join(workspace, file)))
        .digest('hex')
      assert.equal(patch, sha.slice(0, 8), `${name}'s patch is ${file}: set its patch to it`)
    }
    assert.ok(patched.has(`@ai-sdk/harness-claude-code@${HARNESS_PACKAGES['claude-code'].version}`))
  })
})

describe('image recipes', () => {
  const tmp = () => mkdtempSync(join(tmpdir(), 'reeval-recipe-'))

  test('.dockerignore rules match as Docker reads them', () => {
    const ignored = dockerignoreMatcher(
      [
        '# comment',
        'node_modules',
        '/dist/',
        '*.log',
        '**/cache',
        'docs/**/*.md',
        '!docs/keep.md',
        '',
      ].join('\n'),
    )
    assert.equal(ignored('node_modules/a/b.js'), true, 'a directory excludes what is in it')
    assert.equal(ignored('src/node_modules/x'), false, 'patterns are anchored at the context root')
    assert.equal(ignored('dist/index.js'), true)
    assert.equal(ignored('build.log'), true)
    assert.equal(ignored('logs/build.log'), false, '* stays within one path segment')
    assert.equal(ignored('a/b/cache/x'), true, '** spans directories')
    assert.equal(ignored('docs/guide/intro.md'), true)
    assert.equal(ignored('docs/keep.md'), false, '! re-includes; the last matching rule wins')
    assert.equal(ignored('src/index.ts'), false)
  })

  test('the Dockerfile tag hashes the Dockerfile and its build context, less .dockerignore', () => {
    const dir = tmp()
    const file = join(dir, 'Dockerfile')
    writeFileSync(file, 'FROM debian:bookworm-slim\nCOPY tool.sh /usr/local/bin/tool\n')
    writeFileSync(join(dir, 'tool.sh'), 'echo 1\n')
    writeFileSync(join(dir, '.dockerignore'), 'scratch\nDockerfile\n')
    mkdirSync(join(dir, 'scratch'))
    const first = dockerfileTag(file, 'cursor')
    assert.match(first.tag, /^reeval-dockerfile:reeval-recipe-[a-z0-9]+-[0-9a-f]{16}$/)
    assert.deepEqual(contextFiles(dir, file), ['.dockerignore', 'Dockerfile', 'tool.sh'])
    writeFileSync(join(dir, 'scratch', 'notes.txt'), 'ignored')
    assert.equal(
      dockerfileTag(file, 'cursor').tag,
      first.tag,
      'ignored files do not change the hash',
    )
    writeFileSync(join(dir, 'tool.sh'), 'echo 2\n')
    const edited = dockerfileTag(file, 'cursor')
    assert.notEqual(edited.tag, first.tag, 'a context file changes the hash')
    writeFileSync(file, 'FROM debian:bookworm-slim\nCOPY tool.sh /usr/local/bin/tool\nRUN true\n')
    assert.notEqual(
      dockerfileTag(file, 'cursor').tag,
      edited.tag,
      'the Dockerfile changes the hash',
    )
    const named = join(dir, 'python.Dockerfile')
    writeFileSync(named, 'FROM python:3.12-slim\n')
    assert.match(dockerfileTag(named, 'cursor').tag, /^reeval-dockerfile:python-dockerfile-/)
    assert.equal(
      dockerfileTag(file, 'claude-code').tag,
      dockerfileTag(file, 'cursor').tag,
      'a Dockerfile without REEVAL_BASE builds the same for every harness (each gets its CLI baked on)',
    )
    const onReeval = join(dir, 'reeval.Dockerfile')
    writeFileSync(onReeval, 'ARG REEVAL_BASE\nFROM $REEVAL_BASE\n')
    assert.notEqual(
      dockerfileTag(onReeval, 'claude-code', 'sha256:a').tag,
      dockerfileTag(onReeval, 'cursor', 'sha256:a').tag,
      "REEVAL_BASE is the harness's image, so each harness builds its own",
    )
  })

  test('install commands run in order from /, in one script, stopping at the first failure', () => {
    const dir = tmp()
    // Forward slashes: the script is for a Linux container, and Git Bash takes C:/… on Windows.
    const out = join(dir, 'out.txt').replaceAll('\\', '/')
    const script = installScript([
      { run: `pwd >> ${out}` },
      { run: `echo "it's two" >> ${out}\necho line >> ${out}` },
      { run: 'exit 7' },
      { run: `echo never >> ${out}` },
    ])
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
    assert.equal(r.status, 7)
    assert.equal(readFileSync(out, 'utf8'), "/\nit's two\nline\n")
    assert.match(r.stderr, /reeval: install 3\/4 exited 7: exit 7/)
    assert.match(
      installScript([{ run: 'sleep 1', timeoutMs: 90_000 }]),
      /timeout --kill-after=10 90 bash -c 'sleep 1'/,
    )
  })

  test('install layers are keyed on the base image id and the exact list', () => {
    const steps = [{ run: 'apt-get install -y jq' }]
    const tag = installLayerTag({ id: 'sha256:a' }, steps)
    assert.match(tag, /^reeval-install:[0-9a-f]{16}$/)
    assert.notEqual(installLayerTag({ id: 'sha256:b' }, steps), tag)
    assert.notEqual(installLayerTag({ id: 'sha256:a' }, [...steps, { run: 'true' }]), tag)
    assert.equal(installLayerTag({ id: 'sha256:a' }, [{ run: 'apt-get install -y jq' }]), tag)
  })
})

describe('docker command traces', () => {
  test('each command is reported with its output, binary as a byte count, long args clipped', () => {
    const seen: DockerCommand[] = []
    onDockerCommand((c) => seen.push(c))
    try {
      const at = Date.now()
      traceDocker(['version'], at, {
        exitCode: 0,
        stdout: Buffer.from('29.8.1\n'),
        stderr: '',
        stdin: 3,
      })
      traceDocker(['exec', 'c1', 'cat', '--', '/f'], at, {
        exitCode: 0,
        stdout: Buffer.from([0, 255, 1]),
      })
      traceDocker(['exec', 'c1', 'node', '-e', 'x'.repeat(400)], at, { error: new Error('killed') })
      traceDocker(['ps'], at, { exitCode: 0 }, 'podman')
    } finally {
      onDockerCommand(undefined)
    }
    traceDocker(['ps'], Date.now(), { exitCode: 0 })
    assert.deepEqual(
      seen.map(({ ms: _, ...c }) => c),
      [
        {
          bin: 'docker',
          args: ['version'],
          exitCode: 0,
          stdout: '29.8.1\n',
          stderr: '',
          stdin: 3,
        },
        {
          bin: 'docker',
          args: ['exec', 'c1', 'cat', '--', '/f'],
          exitCode: 0,
          stdout: '<3 bytes>',
          stderr: '',
        },
        {
          bin: 'docker',
          args: ['exec', 'c1', 'node', '-e', `${'x'.repeat(300)}… (100 more)`],
          exitCode: null,
          stdout: '',
          stderr: '',
          error: 'killed',
        },
        { bin: 'podman', args: ['ps'], exitCode: 0, stdout: '', stderr: '' },
      ],
      'nothing once the listener is gone',
    )
  })
})
