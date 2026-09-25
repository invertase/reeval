import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import https from 'node:https'
import type net from 'node:net'
import { after, before, describe, test } from 'node:test'
import type { HarnessV1RequestTransformation } from '@ai-sdk/harness'
import { createCertificateAuthority, issueServerCertificate } from '../src/egress/cert.ts'
import type { Substitution } from '../src/egress/substitution.ts'
import { BRIDGE_PORT, DEFAULT_IMAGE } from '../src/image.ts'
import { createDockerSession, type DockerSession, type EgressOptions } from '../src/session.ts'

// ES_TEST_REQUIRE_DOCKER=1 (CI's docker job) fails instead of skipping.
const dockerReady =
  process.env.ES_TEST_REQUIRE_DOCKER === '1' ||
  (() => {
    try {
      execFileSync('docker', ['image', 'inspect', DEFAULT_IMAGE], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  })()

/** ES's image with Python on top, built once and then from Docker's layer cache. */
const PYTHON_IMAGE = `evalsuite-test-python:${DEFAULT_IMAGE.split(':')[1]}`
const pythonImage = () => {
  try {
    execFileSync('docker', ['build', '-q', '-t', PYTHON_IMAGE, '-'], {
      input: `FROM ${DEFAULT_IMAGE}\nRUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*\n`,
      stdio: ['pipe', 'ignore', 'pipe'],
    })
    return true
  } catch {
    return false
  }
}

const PLACEHOLDER = `aisdkhc_${'Z'.repeat(43)}`
const REAL = 'crsr_docker_test_real_key_9f8e7d6c5b4a39281706'
/** What the in-container search looks for: a distinctive tail, so the full key never goes in. */
const NEEDLE = REAL.slice(-20)

const upstreamCa = createCertificateAuthority()
const seen: { path: string; authorization?: string; body: string }[] = []

/** Echoes the Authorization header and the body back as JSON. */
function startUpstream(): Promise<{ port: number; close(): void }> {
  const leaf = issueServerCertificate(upstreamCa, 'upstream.test')
  const server = https.createServer(
    { key: leaf.key.export({ type: 'pkcs8', format: 'pem' }), cert: leaf.cert },
    (req, res) => {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (d) => {
        body += d
      })
      req.on('end', () => {
        seen.push({ path: req.url ?? '', authorization: req.headers.authorization, body })
        res.end(JSON.stringify({ authorization: req.headers.authorization, body }))
      })
    },
  )
  return new Promise((resolve) =>
    server.listen(0, '0.0.0.0', () =>
      resolve({ port: (server.address() as net.AddressInfo).port, close: () => server.close() }),
    ),
  )
}

const cursorRule: HarnessV1RequestTransformation = {
  match: {
    host: 'upstream.test',
    path: { exact: '/auth/exchange_user_api_key' },
    method: ['POST'],
    headers: [{ key: { exact: 'Authorization' }, value: { exact: `Bearer ${PLACEHOLDER}` } }],
  },
  transform: { headers: { Authorization: `Bearer ${REAL}` } },
}

const egress = (over: Partial<EgressOptions> = {}): EgressOptions => ({
  upstreamCA: upstreamCa.cert,
  lookup: async (host) => (host.endsWith('.test') ? ['127.0.0.1'] : ['1.1.1.1']),
  allowLoopback: true,
  ...over,
})

const sh = async (s: DockerSession, command: string, env?: Record<string, string>) =>
  s.run({ command, ...(env ? { env } : {}) })

// Interfaces with IFF_UP set. Docker Desktop's kernel adds tunnel devices (gre0, sit0…) that stay
// down, and names an interface attached later eth1 rather than eth0.
const upInterfaces = async (s: DockerSession) =>
  (
    await sh(
      s,
      'for f in /sys/class/net/*/flags; do [ $(( $(cat "$f") & 1 )) -eq 1 ] && basename "$(dirname "$f")"; done; true',
    )
  ).stdout
    .split('\n')
    .filter(Boolean)

describe('egress gateway in Docker', {
  skip: !dockerReady && `needs Docker and ${DEFAULT_IMAGE}`,
}, () => {
  let upstream: { port: number; close(): void }
  const sessions: DockerSession[] = []
  const open = async (options: Parameters<typeof createDockerSession>[0]) => {
    const s = await createDockerSession(options)
    sessions.push(s)
    return s
  }
  before(async () => {
    upstream = await startUpstream()
  })
  after(async () => {
    await Promise.all(sessions.map((s) => s.destroy()))
    upstream.close()
  })

  test('with endpoints, a host-wide rule keys only those; the rest get a 403 from the gateway', async () => {
    const s = await open({
      image: DEFAULT_IMAGE,
      egress: egress({
        endpoints: [{ host: 'upstream.test', path: { exact: '/v1/messages' }, method: ['POST'] }],
      }),
    })
    await s.addRequestTransformations?.([
      {
        match: {
          host: 'upstream.test',
          headers: [{ key: { exact: 'Authorization' }, value: { exact: `Bearer ${PLACEHOLDER}` } }],
        },
        transform: { headers: { Authorization: `Bearer ${REAL}` } },
      },
    ])
    const call = (method: string, path: string) =>
      sh(
        s,
        `curl -sS --max-time 20 -o /dev/null -w '%{http_code}' -X ${method} -H "Authorization: Bearer $KEY" https://upstream.test:${upstream.port}${path}`,
        { KEY: PLACEHOLDER },
      )
    seen.length = 0
    assert.equal((await call('POST', '/v1/messages?beta=true')).stdout, '200')
    assert.equal(seen[0]?.authorization, `Bearer ${REAL}`)
    seen.length = 0
    for (const [method, path] of [
      ['GET', '/v1/models'],
      ['POST', '/v1/files'],
    ]) {
      const r = await call(method as string, path as string)
      assert.equal(r.stdout, '403', `${method} ${path}: ${r.stderr}`)
    }
    assert.equal(seen.length, 0, 'refused requests never reach upstream')
  })

  test('the container gets only the placeholder; the exchange request upstream gets the key', async () => {
    const s = await open({ image: DEFAULT_IMAGE, egress: egress() })
    assert.deepEqual(s.egress, { active: true })
    assert.equal(typeof s.addRequestTransformations, 'function')
    await s.addRequestTransformations?.([cursorRule])
    seen.length = 0
    const url = `https://upstream.test:${upstream.port}/auth/exchange_user_api_key`
    // curl verifies the decrypted connection against the system trust store.
    const swapped = await sh(s, `curl -sS -X POST -H "Authorization: Bearer $KEY" ${url}`, {
      KEY: PLACEHOLDER,
    })
    assert.equal(swapped.exitCode, 0, swapped.stderr)
    assert.equal(JSON.parse(swapped.stdout).authorization, `Bearer ${REAL}`)
    const other = await sh(s, `curl -sS -H "Authorization: Bearer $KEY" ${url}`, {
      KEY: PLACEHOLDER,
    })
    assert.equal(JSON.parse(other.stdout).authorization, `Bearer ${PLACEHOLDER}`, 'GET: no swap')
    assert.deepEqual(
      seen.map((r) => r.authorization),
      [`Bearer ${REAL}`, `Bearer ${PLACEHOLDER}`],
    )
    const env = await sh(s, 'env')
    assert.match(env.stdout, /^HTTPS_PROXY=http:\/\/127\.0\.0\.1:43128$/m)
    assert.match(env.stdout, /^NODE_EXTRA_CA_CERTS=\/usr\/local\/share\/ca-certificates\//m)
  })

  test('env, /proc and files in the container never contain the real key', async () => {
    const s = await open({ image: DEFAULT_IMAGE, egress: egress() })
    await s.addRequestTransformations?.([cursorRule])
    // A long-lived process holding the placeholder, as the harness bridge does.
    const bridge = await s.spawn({ command: 'sleep 300', env: { CURSOR_API_KEY: PLACEHOLDER } })
    await sh(
      s,
      `curl -sS -X POST -H "Authorization: Bearer $CURSOR_API_KEY" https://upstream.test:${upstream.port}/auth/exchange_user_api_key -o /dev/null`,
      {
        CURSOR_API_KEY: PLACEHOLDER,
      },
    )
    const environ = await sh(
      s,
      "cat /proc/[0-9]*/environ | tr '\\0' '\\n'; cat /proc/[0-9]*/cmdline | tr '\\0' ' '",
    )
    assert.match(environ.stdout, new RegExp(PLACEHOLDER), 'the check can see process environments')
    assert.doesNotMatch(environ.stdout, new RegExp(NEEDLE))
    const files = await sh(
      s,
      `grep -rlsF --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev "$N" / ; echo "exit=$?"`,
      { N: NEEDLE },
    )
    assert.equal(files.stdout.trim(), 'exit=1', `files containing the key: ${files.stdout}`)
    await bridge.kill()
  })

  test('a brokered secret: the upstream gets the value, the container only ever the placeholder', async () => {
    const secret = 'user-secret-docker-8a7b6c5d4e3f2a1b0c9d'
    const holder = `es_secret_${'D'.repeat(32)}`
    const s = await open({
      image: DEFAULT_IMAGE,
      egress: egress(),
      env: { GEMINI_API_KEY: holder },
    })
    await s.setSubstitutions?.([
      {
        name: 'GEMINI_API_KEY',
        placeholder: holder,
        value: secret,
        hosts: ['upstream.test'],
        in: ['header'],
      },
    ])
    seen.length = 0
    // No --cacert: curl trusts the gateway through the system bundle ES points it at.
    const r = await sh(
      s,
      `curl -sS -H "Authorization: Bearer $GEMINI_API_KEY" https://upstream.test:${upstream.port}/v1`,
    )
    assert.equal(r.exitCode, 0, r.stderr)
    assert.equal(seen[0]?.authorization, `Bearer ${secret}`, 'the upstream got the value')
    assert.equal(
      JSON.parse(r.stdout).authorization,
      `Bearer ${holder}`,
      'the echo came back scrubbed',
    )
    const tail = secret.slice(-20)
    const environ = await sh(s, "cat /proc/[0-9]*/environ | tr '\\0' '\\n'")
    assert.match(environ.stdout, new RegExp(holder), 'twin: the search sees the placeholder')
    assert.doesNotMatch(environ.stdout, new RegExp(tail))
    const files = await sh(
      s,
      `grep -rlsF --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev "$N" / ; echo "exit=$?"`,
      { N: tail },
    )
    assert.equal(files.stdout.trim(), 'exit=1', `files containing the value: ${files.stdout}`)
    const env = (await sh(s, 'env')).stdout
    for (const name of [
      'SSL_CERT_FILE',
      'REQUESTS_CA_BUNDLE',
      'CURL_CA_BUNDLE',
      'GIT_SSL_CAINFO',
    ]) {
      assert.match(env, new RegExp(`^${name}=/etc/ssl/certs/ca-certificates\\.crt$`, 'm'), name)
    }
    assert.match(env, /^NODE_USE_ENV_PROXY=1$/m)
  })

  const token = 'user-token-docker-1f2e3d4c5b6a79880a1b'
  const tokenHolder = `es_secret_${'T'.repeat(32)}`
  const brokered = async (
    image: string,
    over: Partial<EgressOptions> = {},
    where: Substitution['in'] = ['header'],
  ) => {
    const s = await open({ image, egress: egress(over), env: { SERVICE_TOKEN: tokenHolder } })
    await s.setSubstitutions?.([
      {
        name: 'SERVICE_TOKEN',
        placeholder: tokenHolder,
        value: token,
        hosts: ['upstream.test'],
        in: where,
      },
    ])
    seen.length = 0
    return s
  }

  test('a body substituted on the way out is reflected back through curl as the placeholder', async () => {
    const url = `https://upstream.test:${upstream.port}/reflect`
    const reflect = async (s: DockerSession) => {
      const r = await sh(
        s,
        `curl -sS -H 'content-type: application/json' --data "{\\"token\\":\\"$SERVICE_TOKEN\\"}" ${url}`,
      )
      assert.equal(r.exitCode, 0, r.stderr)
      assert.equal(seen.at(-1)?.body, `{"token":"${token}"}`, 'the upstream got the value')
      return r.stdout
    }
    const scrubbed = await reflect(await brokered(DEFAULT_IMAGE, {}, ['header', 'body']))
    assert.equal(JSON.parse(scrubbed).body, `{"token":"${tokenHolder}"}`)
    assert.doesNotMatch(scrubbed, new RegExp(token))
    const raw = await reflect(
      await brokered(DEFAULT_IMAGE, { scrubResponses: false }, ['header', 'body']),
    )
    assert.match(raw, new RegExp(token), 'twin: unscrubbed, the search finds the value')
  })

  test('Python and curl trust the gateway; against another bundle they refuse it', async (t) => {
    if (!pythonImage()) return t.skip(`couldn't build ${PYTHON_IMAGE}`)
    const s = await brokered(PYTHON_IMAGE)
    const url = `https://upstream.test:${upstream.port}/ca`
    const clients = {
      python: `python3 -c 'import os, urllib.request as u; print(u.urlopen(u.Request("${url}", headers={"Authorization": "Bearer " + os.environ["SERVICE_TOKEN"]})).read().decode())'`,
      curl: `curl -sS -H "Authorization: Bearer $SERVICE_TOKEN" ${url}`,
    }
    for (const [name, command] of Object.entries(clients)) {
      const r = await sh(s, command)
      assert.equal(r.exitCode, 0, `${name}: ${r.stderr}`)
      assert.equal(JSON.parse(r.stdout).authorization, `Bearer ${tokenHolder}`, name)
    }
    assert.deepEqual(
      seen.map((r) => r.authorization),
      [`Bearer ${token}`, `Bearer ${token}`],
    )
    // Twin: against a bundle without the gateway's CA, both refuse the connection, so they do
    // verify. Python follows the variables; Debian's curl always reads the hashed /etc/ssl/certs
    // too, which no variable turns off, so it's told with flags.
    await sh(s, 'printf "%s" "$PEM" > /tmp/other.pem', { PEM: upstreamCa.cert })
    const refused = [
      sh(s, clients.python, { SSL_CERT_FILE: '/tmp/other.pem', SSL_CERT_DIR: '/nonexistent' }),
      sh(s, clients.curl.replace(/^curl /, 'curl --cacert /tmp/other.pem --capath /nonexistent ')),
    ]
    for (const r of await Promise.all(refused)) {
      assert.notEqual(r.exitCode, 0, `verified against another bundle: ${r.stdout}`)
      assert.match(r.stderr, /certificate|SSL/i)
    }
  })

  test('Node fetch goes through the gateway with NODE_USE_ENV_PROXY, and not without it', async () => {
    const s = await brokered(DEFAULT_IMAGE)
    const url = `https://upstream.test:${upstream.port}/fetch`
    const script = `fetch("${url}", { headers: { authorization: "Bearer " + process.env.SERVICE_TOKEN } }).then((r) => r.text()).then(console.log, (e) => { console.error(String(e.cause ?? e)); process.exit(1) })`
    const r = await sh(s, `node -e '${script}'`)
    assert.equal(r.exitCode, 0, r.stderr)
    assert.equal(JSON.parse(r.stdout).authorization, `Bearer ${tokenHolder}`)
    assert.equal(seen[0]?.authorization, `Bearer ${token}`)
    // Twin: without it, Node 22's fetch ignores the proxy and can't even resolve the host.
    const direct = await sh(s, `env -u NODE_USE_ENV_PROXY node -e '${script}'`)
    assert.notEqual(direct.exitCode, 0)
    assert.match(direct.stderr, /ENOTFOUND|EAI_AGAIN|getaddrinfo/)
  })

  test('a restricted policy leaves the gateway as the only way out', async () => {
    const s = await open({
      image: DEFAULT_IMAGE,
      egress: egress({ policy: { mode: 'custom', allowedHosts: ['upstream.test'] } }),
    })
    assert.deepEqual(await upInterfaces(s), ['lo'])
    const allowed = await sh(
      s,
      `curl -sS https://upstream.test:${upstream.port}/x -o /dev/null -w '%{http_code}'`,
    )
    // Not decrypted (no rules), so curl can't verify the test server's own CA: that's the TLS
    // error, not a refusal, and it proves the tunnel reached the upstream.
    assert.match(allowed.stderr, /certificate|SSL/i, allowed.stderr)
    const refused = await sh(s, `curl -sS https://other.test:${upstream.port}/`)
    assert.equal(refused.exitCode, 56, refused.stderr)
    assert.match(refused.stderr, /403/)
    const direct = await sh(s, "curl -sS --noproxy '*' --max-time 5 https://1.1.1.1/")
    assert.notEqual(direct.exitCode, 0, 'no direct route')
    assert.match(direct.stderr, /resolve|connect|unreachable/i)

    // The bridge port, published nowhere, is reached through the tunnel.
    const server = await s.spawn({
      command: `node -e "require('http').createServer((q, r) => r.end('bridge ok')).listen(43210, '0.0.0.0')"`,
    })
    const { url } = await s.getPortEndpoint({ port: 43210, protocol: 'http' })
    const body = await retry(() => get(url))
    assert.equal(body, 'bridge ok')

    await s.setNetworkPolicy?.({ mode: 'deny-all' })
    const denied = await sh(s, `curl -sS https://upstream.test:${upstream.port}/`)
    assert.match(denied.stderr, /403/)

    // Reattached to its networks, the container keeps the same tunnel endpoint: nothing relies on
    // Docker republishing the port, which Docker Desktop doesn't do on reconnect.
    await s.setNetworkPolicy?.({ mode: 'allow-all' })
    assert.ok((await upInterfaces(s)).some((i) => /^eth\d+$/.test(i)))
    const reopened = await s.getPortEndpoint({ port: 43210, protocol: 'http' })
    assert.equal(reopened.url, url)
    assert.equal(await retry(() => get(reopened.url)), 'bridge ok')
    await server.kill()
  })

  test('without the gateway the bridge port is published, and an unpublished port is an error', async () => {
    const s = await open({ image: DEFAULT_IMAGE })
    const server = await s.spawn({
      command: `node -e "require('http').createServer((q, r) => r.end('published ok')).listen(${BRIDGE_PORT}, '0.0.0.0')"`,
    })
    const { url } = await s.getPortEndpoint({ port: BRIDGE_PORT, protocol: 'http' })
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.equal(await retry(() => get(url)), 'published ok')
    await assert.rejects(s.getPortEndpoint({ port: 43211 }), /Port 43211 of \w+ isn't reachable/)
    await server.kill()
  })

  test('without node the gateway falls back (allow-all) or refuses (restricted)', async () => {
    try {
      execFileSync('docker', ['pull', '-q', 'busybox:1.37'], { stdio: 'ignore' })
    } catch {
      return
    }
    const s = await open({ image: 'busybox:1.37', egress: egress() })
    assert.equal(s.egress?.active, false)
    assert.match(s.egress?.active === false ? s.egress.reason : '', /forwarder/)
    assert.equal(s.addRequestTransformations, undefined)
    assert.equal(s.setNetworkPolicy, undefined)
    await assert.rejects(
      createDockerSession({
        image: 'busybox:1.37',
        labels: { 'dev.evalsuite.test': 'fallback' },
        egress: egress({ policy: { mode: 'deny-all' } }),
      }),
      /Can't enforce the egress policy/,
    )
    const left = execFileSync(
      'docker',
      ['ps', '-aq', '--filter', 'label=dev.evalsuite.test=fallback'],
      { encoding: 'utf8' },
    )
    assert.equal(left.trim(), '', 'the refused container was removed')
  })

  test('destroy stops the tunnel and removes the container', async () => {
    const s = await createDockerSession({ image: DEFAULT_IMAGE, egress: egress() })
    const tunnels = () =>
      execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' })
        .split('\n')
        .filter((l) => l.startsWith(`docker exec --interactive ${s.id} node -e`)).length
    assert.equal(tunnels(), 1)
    await s.destroy()
    await new Promise((r) => setTimeout(r, 500))
    assert.equal(tunnels(), 0)
    const exists = execFileSync('docker', ['ps', '-aq', '--filter', `id=${s.id}`], {
      encoding: 'utf8',
    })
    assert.equal(exists.trim(), '')
  })
})

const get = (url: string) =>
  new Promise<string>((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = ''
        res.on('data', (d) => {
          body += d
        })
        res.on('end', () => resolve(body))
      })
      .once('error', reject)
  })

async function retry<T>(fn: () => Promise<T>, tries = 30): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn()
    } catch (error) {
      if (i >= tries) throw error
      await new Promise((r) => setTimeout(r, 200))
    }
  }
}

describe('image info', { skip: !dockerReady && `needs Docker and ${DEFAULT_IMAGE}` }, () => {
  test('reads labelled images and images without labels', async () => {
    const { imageInfo } = await import('../src/docker-cli.ts')
    const ours = await imageInfo(DEFAULT_IMAGE)
    assert.match(ours?.labels['dev.evalsuite.agent-version'] ?? '', /\d/)
    // Built here, so no registry digest, on the classic and the containerd image store alike.
    assert.deepEqual(ours?.repoDigests, [])
    try {
      execFileSync('docker', ['pull', '-q', 'busybox:1.37'], { stdio: 'ignore' })
    } catch {
      return
    }
    const plain = await imageInfo('busybox:1.37')
    assert.deepEqual(plain?.labels, {})
    assert.match(plain?.id ?? '', /^sha256:/)
    assert.equal(await imageInfo('evalsuite-no-such-image:missing'), null)
  })
})
