import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import http from 'node:http'
import https from 'node:https'
import type net from 'node:net'
import { after, before, describe, test } from 'node:test'
import type { HarnessV1RequestTransformation } from '@ai-sdk/harness'
import { createCertificateAuthority, issueServerCertificate } from '../src/egress/cert.ts'
import { PROXY_PORT } from '../src/egress/gateway.ts'
import type { NetworkPolicy } from '../src/egress/policy.ts'
import type { Substitution } from '../src/egress/substitution.ts'
import { BRIDGE_PORT, DEFAULT_IMAGE } from '../src/image.ts'
import { createDockerSession, type DockerSession, type EgressOptions } from '../src/session.ts'

// REEVAL_TEST_REQUIRE_DOCKER=1 (CI's docker job) fails instead of skipping.
const dockerReady =
  process.env.REEVAL_TEST_REQUIRE_DOCKER === '1' ||
  (() => {
    try {
      execFileSync('docker', ['image', 'inspect', DEFAULT_IMAGE], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  })()

/** reeval's image with Python on top, built once and then from Docker's layer cache. */
const PYTHON_IMAGE = `reeval-test-python:${DEFAULT_IMAGE.split(':')[1]}`
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

/** An exchange's response: JWTs whose signatures are the part that must never enter. */
const SIGNATURE = 'real-docker-signature-5e4d3c2b1a09'
const TOKENS = {
  accessToken: `eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjIwMDAwMDAwMDB9.${SIGNATURE}`,
  refreshToken: `eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjIxMDAwMDAwMDB9.${SIGNATURE}-r`,
}

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
        if (req.url === '/tokens') return res.end(JSON.stringify(TOKENS))
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

/** As root in the container, outside the session: what the gateway's own execs run as. */
const asRoot = (s: DockerSession, command: string) =>
  spawnSync('docker', ['exec', '--user', '0:0', s.id, 'sh', '-c', command], { encoding: 'utf8' })

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
    // Only what grep lists counts: as the sandbox user it can't read every directory, so it exits 2.
    const grep = `grep -rlsF --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev ${NEEDLE} / ; echo end`
    const files = await sh(s, grep)
    assert.equal(files.stdout.trim(), 'end', `files containing the key: ${files.stdout}`)
    // The sandbox user can't read root's files, and root (with no capabilities) can't read the
    // sandbox user's private ones, so search as both.
    const rootFiles = asRoot(s, `${grep}; cat /proc/[0-9]*/environ | grep -c ${NEEDLE}`)
    assert.equal(rootFiles.stdout.trim(), 'end\n0', `as root: ${rootFiles.stdout}`)
    await bridge.kill()
  })

  test('a brokered secret: the upstream gets the value, the container only ever the placeholder', async () => {
    const secret = 'user-secret-docker-8a7b6c5d4e3f2a1b0c9d'
    const holder = `reeval_secret_${'D'.repeat(32)}`
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
    // No --cacert: curl trusts the gateway through the system bundle reeval points it at.
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
      `grep -rlsF --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev "$N" / ; echo end`,
      { N: tail },
    )
    assert.equal(files.stdout.trim(), 'end', `files containing the value: ${files.stdout}`)
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

  test('derived tokens: auth.json holds placeholders, and requests carry the real token upstream', async () => {
    const s = await open({
      image: DEFAULT_IMAGE,
      egress: egress({
        derivedTokens: [
          {
            name: 'CURSOR_API_KEY',
            endpoint: { host: 'upstream.test', path: { exact: '/tokens' }, method: ['POST'] },
            fields: ['accessToken', 'refreshToken'],
            hosts: ['upstream.test'],
          },
        ],
      }),
    })
    const base = `https://upstream.test:${upstream.port}`
    // As the CLI does: store the exchange's tokens, then send the access token on later requests.
    const stored = await sh(
      s,
      `mkdir -p ~/.config/cursor && curl -sS -X POST ${base}/tokens > ~/.config/cursor/auth.json`,
    )
    assert.equal(stored.exitCode, 0, stored.stderr)
    seen.length = 0
    const used = await sh(
      s,
      `T=$(sed -E 's/.*"accessToken":"([^"]*)".*/\\1/' ~/.config/cursor/auth.json); curl -sS -o /dev/null -H "Authorization: Bearer $T" ${base}/v1`,
    )
    assert.equal(used.exitCode, 0, used.stderr)
    assert.equal(seen[0]?.authorization, `Bearer ${TOKENS.accessToken}`, 'upstream got the token')
    const auth = (await sh(s, 'cat ~/.config/cursor/auth.json')).stdout
    assert.match(
      auth,
      /"accessToken":"eyJhbGciOiJIUzI1NiJ9\.eyJleHAiOjIwMDAwMDAwMDB9\.reeval_secret_/,
    )
    const files = await sh(
      s,
      `grep -rlsF --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev "$N" / ; echo end`,
      { N: SIGNATURE },
    )
    assert.equal(files.stdout.trim(), 'end', `files containing a real token: ${files.stdout}`)
    // Twin: the same search for the placeholder's signature finds auth.json.
    const signature = /\.(reeval_secret_\w+)"/.exec(auth)?.[1] ?? ''
    const twin = await sh(
      s,
      `grep -rlsF --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev "$N" / ; echo end`,
      { N: signature },
    )
    assert.match(twin.stdout, /\.config\/cursor\/auth\.json/)
  })

  const token = 'user-token-docker-1f2e3d4c5b6a79880a1b'
  const tokenHolder = `reeval_secret_${'T'.repeat(32)}`
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
    // busybox has no sandbox user, so root; without it, the session says why it can't start.
    await assert.rejects(
      createDockerSession({
        image: 'busybox:1.37',
        labels: { 'ai.reeval.test': 'no-user' },
      }),
      /busybox:1\.37 has no reeval user to run the sandbox as[\s\S]*docker\(\{ root: true \}\)/,
    )
    await retry(async () =>
      assert.equal(
        execFileSync('docker', ['ps', '-aq', '--filter', 'label=ai.reeval.test=no-user'], {
          encoding: 'utf8',
        }).trim(),
        '',
      ),
    )
    const s = await open({ image: 'busybox:1.37', root: true, egress: egress() })
    assert.equal(s.egress?.active, false)
    assert.match(s.egress?.active === false ? s.egress.reason : '', /forwarder/)
    assert.equal(s.addRequestTransformations, undefined)
    assert.equal(s.setNetworkPolicy, undefined)
    await assert.rejects(
      createDockerSession({
        image: 'busybox:1.37',
        root: true,
        labels: { 'ai.reeval.test': 'fallback' },
        egress: egress({ policy: { mode: 'deny-all' } }),
      }),
      /Can't enforce the egress policy/,
    )
    const left = execFileSync(
      'docker',
      ['ps', '-aq', '--filter', 'label=ai.reeval.test=fallback'],
      { encoding: 'utf8' },
    )
    assert.equal(left.trim(), '', 'the refused container was removed')
  })

  test('destroy stops the tunnel and removes the container', async () => {
    const s = await createDockerSession({ image: DEFAULT_IMAGE, egress: egress() })
    const tunnels = () =>
      execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' })
        .split('\n')
        .filter((l) => l.startsWith(`docker exec --interactive --user 0:0 ${s.id} node -e`)).length
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

describe('egress policy in Docker', {
  skip: !dockerReady && `needs Docker and ${DEFAULT_IMAGE}`,
}, () => {
  const allowAll: NetworkPolicy = { mode: 'allow-all' }
  const denyAll: NetworkPolicy = { mode: 'deny-all' }
  const custom: NetworkPolicy = { mode: 'custom', allowedHosts: ['upstream.test'] }
  let upstream: { port: number; close(): void }
  /** A plain HTTP listener on every host interface, counting what reaches it. */
  let listener: { port: number; hits: number; close(): void }
  /** The host as a container on the default bridge reaches it directly. */
  let hostAddress: string
  const sessions: DockerSession[] = []
  const open = async (policy: NetworkPolicy) => {
    const s = await createDockerSession({ image: DEFAULT_IMAGE, egress: egress({ policy }) })
    sessions.push(s)
    return s
  }
  const direct = (s: DockerSession) =>
    sh(
      s,
      `curl -sS --noproxy '*' --max-time 3 -o /dev/null -w '%{http_code}' http://${hostAddress}:${listener.port}/`,
    )
  /** Only `lo` is up, and a direct connect to the host listener neither succeeds nor lands. */
  const expectNoDirectRoute = async (s: DockerSession, what: string) => {
    assert.deepEqual(await upInterfaces(s), ['lo'], what)
    const hits = listener.hits
    const r = await direct(s)
    assert.notEqual(r.exitCode, 0, `${what}: a direct connect got ${r.stdout}`)
    assert.equal(listener.hits, hits, `${what}: the host listener saw a connection`)
  }
  /** As root: the sandbox user can't signal the forwarder. */
  const killForwarder = (s: DockerSession) => ({
    exitCode: asRoot(s, `pkill -KILL -f '[${String(PROXY_PORT)[0]}]${String(PROXY_PORT).slice(1)}'`)
      .status,
  })

  before(async () => {
    upstream = await startUpstream()
    const server = http.createServer((_, res) => {
      box.hits++
      res.end('host')
    })
    const box = { port: 0, hits: 0, close: () => server.close() }
    await new Promise<void>((r) => server.listen(0, '0.0.0.0', r))
    box.port = (server.address() as net.AddressInfo).port
    listener = box
    // host.docker.internal under Docker Desktop, else the default route's gateway.
    const probe = await open(allowAll)
    hostAddress = (
      await sh(
        probe,
        `h=$(getent ahostsv4 host.docker.internal | awk 'NR==1{print $1}'); if [ -z "$h" ]; then g=$(awk '$2=="00000000"{print $3; exit}' /proc/net/route); h=$(printf '%d.%d.%d.%d' 0x\${g:6:2} 0x\${g:4:2} 0x\${g:2:2} 0x\${g:0:2}); fi; echo "$h"`,
      )
    ).stdout.trim()
    assert.match(hostAddress, /^\d+\.\d+\.\d+\.\d+$/)
  })
  after(async () => {
    await Promise.all(sessions.map((s) => s.destroy()))
    upstream.close()
    listener.close()
  })

  test('allowlist: a listed host gets 200, any other a 403 that says why', async () => {
    const s = await open(custom)
    await sh(s, 'printf "%s" "$PEM" > /tmp/upstream.pem', { PEM: upstreamCa.cert })
    seen.length = 0
    const ok = await sh(
      s,
      `curl -sS --cacert /tmp/upstream.pem -o /dev/null -w '%{http_code}' https://upstream.test:${upstream.port}/e1`,
    )
    assert.equal(ok.stdout, '200', ok.stderr)
    assert.deepEqual(
      seen.map((r) => r.path),
      ['/e1'],
    )
    const plain = await sh(s, `curl -sS -w ' %{http_code}' http://other.test:${upstream.port}/`)
    assert.match(plain.stdout, /isn't in the allowlist[\s\S]* 403$/)
    // Twin of "the listed host got 200": the same request to another host doesn't.
    const other = await sh(
      s,
      `curl -sS --cacert /tmp/upstream.pem -w '%{http_code}' https://other.test:${upstream.port}/`,
    )
    assert.notEqual(other.stdout, '200')
    assert.match(other.stderr, /403/)
    assert.equal(seen.length, 1, 'nothing else reached the upstream')
  })

  test('no direct route: custom and deny-all, at start and after a switch', async () => {
    const s = await open(allowAll)
    // Twin: under allow-all the same direct connect reaches the host listener.
    const hits = listener.hits
    assert.equal((await direct(s)).stdout, '200')
    assert.equal(listener.hits, hits + 1)
    await expectNoDirectRoute(await open(custom), 'custom at start')
    await expectNoDirectRoute(await open(denyAll), 'deny-all at start')
    await s.setNetworkPolicy?.(custom)
    await expectNoDirectRoute(s, 'allow-all → custom')
    await s.setNetworkPolicy?.(denyAll)
    await expectNoDirectRoute(s, 'custom → deny-all')
  })

  test('policy switch: every transition leaves the right interfaces', async () => {
    const modes = { a: allowAll, c: custom, d: denyAll } as const
    const expectMode = async (s: DockerSession, mode: keyof typeof modes, what: string) => {
      const up = await upInterfaces(s)
      if (mode === 'a')
        assert.ok(
          up.some((i) => /^eth\d+$/.test(i)),
          `${what}: ${up}`,
        )
      else assert.deepEqual(up, ['lo'], what)
    }
    // Each sequence walks all six transitions, one from each end.
    for (const [start, walk] of [
      ['a', 'cdadca'],
      ['c', 'dacadc'],
    ] as const) {
      const s = await open(modes[start])
      await expectMode(s, start, `start ${start}`)
      let from: keyof typeof modes = start
      for (const to of walk as unknown as (keyof typeof modes)[]) {
        await s.setNetworkPolicy?.(modes[to])
        await expectMode(s, to, `${from} → ${to}`)
        from = to
      }
    }
    const network = `reeval-test-${process.pid}`
    execFileSync('docker', ['network', 'create', network], { stdio: 'ignore' })
    const s = await createDockerSession({ image: DEFAULT_IMAGE, egress: egress() })
    try {
      execFileSync('docker', ['network', 'connect', network, s.id])
      const networks = () =>
        Object.keys(
          JSON.parse(
            execFileSync(
              'docker',
              ['inspect', '--format', '{{json .NetworkSettings.Networks}}', s.id],
              { encoding: 'utf8' },
            ),
          ) ?? {},
        ).sort()
      assert.deepEqual(networks(), ['bridge', network])
      await s.setNetworkPolicy?.(denyAll)
      assert.deepEqual(networks(), [])
      assert.deepEqual(await upInterfaces(s), ['lo'])
      await s.setNetworkPolicy?.(custom)
      assert.deepEqual(networks(), [], 'restricted → restricted changes nothing')
      await s.setNetworkPolicy?.(allowAll)
      assert.deepEqual(networks(), ['bridge', network], 'both networks come back')
    } finally {
      await s.destroy()
      execFileSync('docker', ['network', 'rm', network], { stdio: 'ignore' })
    }
  })

  test('port tunnel: same URL and live connection across policy changes', async () => {
    for (const [start, walk] of [
      [allowAll, [denyAll, custom, allowAll]],
      [custom, [denyAll, allowAll, custom]],
    ] as const) {
      const s = await open(start)
      const server = await s.spawn({
        command: `node -e "require('http').createServer((q, r) => r.end(String(q.socket.remotePort))).listen(43212, '0.0.0.0')"`,
      })
      const { url } = await s.getPortEndpoint({ port: 43212, protocol: 'http' })
      const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
      try {
        const connection = await retry(() => get(url, agent))
        for (const policy of walk) {
          await s.setNetworkPolicy?.(policy)
          assert.equal((await s.getPortEndpoint({ port: 43212, protocol: 'http' })).url, url)
          assert.equal(
            await get(url, agent),
            connection,
            `the same connection after ${policy.mode}`,
          )
        }
        // Twin: with the gateway's tunnel gone, the same helper fails, so it went through it.
        await killForwarder(s)
        await retry(async () => assert.equal(s.egress?.active, false))
        await assert.rejects(get(url), (e: Error) => !/no answer within/.test(e.message))
      } finally {
        agent.destroy()
        await server.kill().catch(() => {})
      }
    }
  })

  test('forwarder death: later requests fail fast with a reason; still no direct route', async () => {
    const s = await open(custom)
    assert.equal((await killForwarder(s)).exitCode, 0, 'pkill found the forwarder')
    await retry(async () => assert.equal(s.egress?.active, false))
    assert.match(s.egress?.active === false ? s.egress.reason : '', /forwarder exited/)
    const r = await sh(s, `curl -sS --max-time 2 https://upstream.test:${upstream.port}/`)
    assert.equal(r.exitCode, 7, `refused at once, not a timeout: ${r.stderr}`)
    assert.match(r.stderr, /Failed to connect|Connection refused|Couldn't connect/)
    await expectNoDirectRoute(s, 'after the forwarder died')
  })
})

const get = (url: string, agent?: http.Agent, ms = 5000) =>
  new Promise<string>((resolve, reject) => {
    const req = http.get(url, { agent }, (res) => {
      let body = ''
      res.on('data', (d) => {
        body += d
      })
      res.on('end', () => resolve(body))
    })
    req.setTimeout(ms, () => req.destroy(new Error(`no answer within ${ms}ms`)))
    req.once('error', reject)
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
    assert.match(ours?.labels['ai.reeval.agent-version'] ?? '', /\d/)
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
    assert.equal(await imageInfo('reeval-no-such-image:missing'), null)
  })
})
