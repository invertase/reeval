// `registryDigest` against a registry HTTP API on loopback: the token challenge, logins, the
// digest header and the hash of a manifest served without one.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, test } from 'node:test'
import { parseImageRef, registryDigest } from '../src/registry-api.ts'

const INDEX = '{"schemaVersion":2,"mediaType":"application/vnd.oci.image.index.v1+json"}'
const DIGEST = `sha256:${createHash('sha256').update(INDEX).digest('hex')}`
const LOGIN = { username: 'ci', password: 's3cret' }
const basic = `Basic ${Buffer.from('ci:s3cret').toString('base64')}`

type Seen = { method: string; path: string; accept: string; authorization: string }
const seen: Seen[] = []
let base = ''
let host = ''
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', base)
  seen.push({
    method: req.method ?? '',
    path: url.pathname + url.search,
    accept: req.headers.accept ?? '',
    authorization: req.headers.authorization ?? '',
  })
  if (url.pathname === '/token') {
    const scope = url.searchParams.get('scope') ?? ''
    const service = url.searchParams.get('service')
    if (service !== 'fake-registry') return void res.writeHead(400).end()
    if (scope.includes('private/') && req.headers.authorization !== basic) {
      return void res.writeHead(401).end()
    }
    const body = scope.includes('access/')
      ? { access_token: `t:${scope}` }
      : { token: `t:${scope}` }
    return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  }
  const m = /^\/v2\/(.+)\/manifests\/([^/]+)$/.exec(url.pathname)
  if (!m) return void res.writeHead(404).end()
  const [, repository, reference] = m
  if (repository?.startsWith('basic/')) {
    if (req.headers.authorization !== basic) {
      return void res.writeHead(401, { 'www-authenticate': 'Basic realm="fake"' }).end()
    }
  } else if (req.headers.authorization !== `Bearer t:repository:${repository}:pull`) {
    return void res
      .writeHead(401, {
        'www-authenticate': `Bearer realm="${base}/token",service="fake-registry",scope="repository:${repository}:pull"`,
      })
      .end()
  }
  if (reference === 'missing') return void res.writeHead(404).end()
  const headers: Record<string, string> = {
    'content-type': 'application/vnd.oci.image.index.v1+json',
    'content-length': String(Buffer.byteLength(INDEX)),
  }
  if (!repository?.includes('noheader')) headers['docker-content-digest'] = DIGEST
  res.writeHead(200, headers)
  res.end(req.method === 'HEAD' ? undefined : INDEX)
})

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as AddressInfo
  host = `127.0.0.1:${port}`
  base = `http://${host}`
})
after(() => server.close())

describe('registryDigest', () => {
  test('follows the token challenge anonymously and reads the digest header, asking for an index first', async () => {
    seen.length = 0
    assert.deepEqual(await registryDigest(`${host}/acme/tool:1.2`), { digest: DIGEST })
    assert.deepEqual(
      seen.map((s) => `${s.method} ${s.path}`),
      [
        'HEAD /v2/acme/tool/manifests/1.2',
        'GET /token?service=fake-registry&scope=repository%3Aacme%2Ftool%3Apull',
        'HEAD /v2/acme/tool/manifests/1.2',
      ],
    )
    assert.equal(seen[1]?.authorization, '', 'an anonymous token')
    assert.match(seen[0]?.accept ?? '', /^application\/vnd\.oci\.image\.index\.v1\+json, /)
    assert.match(seen[0]?.accept ?? '', /manifest\.list\.v2\+json/)
  })

  test('takes an access_token as a token', async () => {
    assert.deepEqual(await registryDigest(`${host}/access/tool`), { digest: DIGEST })
  })

  test('sends the login for a private image to the token endpoint, and only for its host', async () => {
    seen.length = 0
    const credential = (h: string) => (h === host ? LOGIN : undefined)
    assert.deepEqual(await registryDigest(`${host}/private/tool:1`, { credential }), {
      digest: DIGEST,
    })
    assert.equal(seen[1]?.authorization, basic)
    // Canary: without the login the token endpoint refuses, and so does the lookup.
    const anonymous = await registryDigest(`${host}/private/tool:1`, {
      credential: () => undefined,
    })
    assert.ok('error' in anonymous)
    assert.match(anonymous.error, /refused a token for private\/tool/)
  })

  test('sends the login to a token realm only over HTTPS or loopback', async () => {
    const asked: Record<string, string> = {}
    const fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      const auth = (init?.headers as Record<string, string>)?.authorization ?? ''
      if (url.includes('/token')) {
        asked[new URL(url).origin] = auth
        return new Response(JSON.stringify({ token: 't' }), { status: 200 })
      }
      if (auth !== 'Bearer t') {
        const realm = url.includes('plain') ? 'http://auth.test/token' : 'https://auth.test/token'
        return new Response(null, {
          status: 401,
          headers: { 'www-authenticate': `Bearer realm="${realm}",service="s"` },
        })
      }
      return new Response(null, { status: 200, headers: { 'docker-content-digest': DIGEST } })
    }) as typeof globalThis.fetch
    const credential = () => LOGIN
    assert.deepEqual(await registryDigest('reg.test/plain/tool', { fetch, credential }), {
      digest: DIGEST,
    })
    assert.equal(asked['http://auth.test'], '', 'no login over plain HTTP')
    // Canary: an HTTPS realm gets it.
    await registryDigest('reg.test/tls/tool', { fetch, credential })
    assert.equal(asked['https://auth.test'], basic)
  })

  test('answers a Basic challenge with the login, and refuses without one', async () => {
    assert.deepEqual(await registryDigest(`${host}/basic/tool`, { credential: () => LOGIN }), {
      digest: DIGEST,
    })
    const refused = await registryDigest(`${host}/basic/tool`)
    assert.ok('error' in refused)
    assert.match(refused.error, /refused basic\/tool \(401\).*registry login/)
  })

  test('hashes the manifest when a HEAD leaves the digest header off', async () => {
    seen.length = 0
    assert.deepEqual(await registryDigest(`${host}/acme/noheader:1`), { digest: DIGEST })
    assert.equal(seen.at(-1)?.method, 'GET')
  })

  test('an image the registry lacks, an unreachable registry and a bad reference are errors', async () => {
    const missing = await registryDigest(`${host}/acme/tool:missing`)
    assert.deepEqual(missing, { error: `${host}/acme/tool:missing isn't in ${host}` })
    const closed = await registryDigest('127.0.0.1:1/acme/tool:1')
    assert.ok('error' in closed)
    assert.match(closed.error, /^couldn't reach 127\.0\.0\.1:1: /)
    assert.deepEqual(await registryDigest('Acme/Tool'), {
      error: "Acme/Tool isn't an image reference",
    })
  })

  test('a reference pinned by digest is that digest, with no request', async () => {
    const pinned = `sha256:${'b'.repeat(64)}`
    const fetch = () => assert.fail('no request for a pinned reference')
    assert.deepEqual(await registryDigest(`node:22@${pinned}`, { fetch }), { digest: pinned })
  })

  test('an abort from the caller is thrown, not an error answer', async () => {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(registryDigest(`${host}/acme/tool:1`, { signal: controller.signal }))
  })
})

describe('parseImageRef', () => {
  test('normalizes references as Docker does', () => {
    const pinned = `sha256:${'c'.repeat(64)}`
    for (const [ref, parsed] of [
      [
        'dart:stable',
        { host: 'registry-1.docker.io', repository: 'library/dart', reference: 'stable' },
      ],
      ['node', { host: 'registry-1.docker.io', repository: 'library/node', reference: 'latest' }],
      ['acme/tool', { host: 'registry-1.docker.io', repository: 'acme/tool', reference: 'latest' }],
      [
        'docker.io/library/node:22',
        { host: 'registry-1.docker.io', repository: 'library/node', reference: '22' },
      ],
      [
        'index.docker.io/node:22',
        { host: 'registry-1.docker.io', repository: 'library/node', reference: '22' },
      ],
      [
        'ghcr.io/astral-sh/uv:0.5',
        { host: 'ghcr.io', repository: 'astral-sh/uv', reference: '0.5' },
      ],
      [
        'localhost:5000/a/b/c',
        { host: 'localhost:5000', repository: 'a/b/c', reference: 'latest' },
      ],
      ['localhost/tool:1', { host: 'localhost', repository: 'tool', reference: '1' }],
      [
        `node:22@${pinned}`,
        { host: 'registry-1.docker.io', repository: 'library/node', reference: pinned },
      ],
      [
        'my_org/my-tool__x:v1.0_rc-1',
        { host: 'registry-1.docker.io', repository: 'my_org/my-tool__x', reference: 'v1.0_rc-1' },
      ],
    ] as const) {
      assert.deepEqual(parseImageRef(ref), parsed, ref)
    }
    for (const ref of [
      'Node:22',
      'node:22@sha256:short',
      'node:-bad',
      '',
      'a//b',
      'node:22 ',
      'exa.mple?x/tool:1',
      'a.b#c/tool',
      'host-.test/tool',
    ]) {
      assert.equal(parseImageRef(ref), null, ref)
    }
  })
})
