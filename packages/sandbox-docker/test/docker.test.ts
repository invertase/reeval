import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import https from 'node:https'
import type net from 'node:net'
import { after, before, describe, test } from 'node:test'
import type { HarnessV1RequestTransformation } from '@ai-sdk/harness'
import { createCertificateAuthority, issueServerCertificate } from '../src/egress/cert.ts'
import { DEFAULT_IMAGE } from '../src/image.ts'
import { createDockerSession, type DockerSession, type EgressOptions } from '../src/session.ts'

const dockerReady = (() => {
  try {
    execFileSync('docker', ['image', 'inspect', DEFAULT_IMAGE], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const PLACEHOLDER = `aisdkhc_${'Z'.repeat(43)}`
const REAL = 'crsr_docker_test_real_key_9f8e7d6c5b4a39281706'
/** What the in-container search looks for: a distinctive tail, so the full key never goes in. */
const NEEDLE = REAL.slice(-20)

const upstreamCa = createCertificateAuthority()
const seen: { path: string; authorization?: string }[] = []

function startUpstream(): Promise<{ port: number; close(): void }> {
  const leaf = issueServerCertificate(upstreamCa, 'upstream.test')
  const server = https.createServer(
    { key: leaf.key.export({ type: 'pkcs8', format: 'pem' }), cert: leaf.cert },
    (req, res) => {
      seen.push({ path: req.url ?? '', authorization: req.headers.authorization })
      req.resume()
      req.on('end', () => res.end(JSON.stringify({ authorization: req.headers.authorization })))
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

  test('a restricted policy leaves the gateway as the only way out', async () => {
    const s = await open({
      image: DEFAULT_IMAGE,
      egress: egress({ policy: { mode: 'custom', allowedHosts: ['upstream.test'] } }),
    })
    assert.equal((await sh(s, 'ls /sys/class/net')).stdout.trim(), 'lo')
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

    await s.setNetworkPolicy?.({ mode: 'allow-all' })
    assert.match((await sh(s, 'ls /sys/class/net')).stdout, /eth0/)
    const published = await s.getPortEndpoint({ port: 43210, protocol: 'http' })
    assert.notEqual(published.url, url)
    assert.equal(await retry(() => get(published.url)), 'bridge ok')
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
