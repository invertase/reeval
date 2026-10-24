import { spawn } from 'node:child_process'
import net from 'node:net'
import { Duplex } from 'node:stream'
import { docker } from '../docker-cli.ts'
import { type Engine, engineEnv, engineSpec } from '../engine.ts'
import { traceDocker } from '../trace.ts'
import { createCertificateAuthority } from './cert.ts'
import { createMux, forwarderScript, link } from './mux.ts'
import type { NetworkPolicy } from './policy.ts'
import { createEgressProxy, type EgressProxyOptions, type EgressTraffic } from './proxy.ts'
import type { RequestTransformation } from './rules.ts'
import type { Substitution } from './substitution.ts'

/** Where the forwarder listens inside the container; every exec gets it as its HTTP(S) proxy. */
export const PROXY_PORT = 43128
/** The gateway's CA certificate in the container. The private key never leaves the host. */
export const CA_PATH = '/usr/local/share/ca-certificates/reeval-egress.crt'
/** Debian's system bundle, which `update-ca-certificates` rebuilds with the gateway's CA in it. */
export const CA_BUNDLE = '/etc/ssl/certs/ca-certificates.crt'
const BUNDLED = 'reeval:ca-bundle'

const READY_TIMEOUT_MS = 15_000

/**
 * The gateway's side of the container runs as root, whoever the sandbox runs as: the sandbox user
 * can't signal, trace or replace the forwarder, or change the CA it installed.
 */
const AS_ROOT = ['--user', '0:0']

export type GatewayOptions = Omit<EgressProxyOptions, 'ca'>

export type Gateway = {
  /** Proxy and CA variables for every process in the container. */
  readonly env: Record<string, string>
  addTransformations(rules: readonly RequestTransformation[]): void
  setTransformations(rules: readonly RequestTransformation[]): void
  setPolicy(policy: NetworkPolicy): void
  setSubstitutions(subs: readonly Substitution[]): void
  /** The hosts the sandbox contacted and was refused so far. */
  traffic(): EgressTraffic
  /** A 127.0.0.1 URL on the host that reaches `port` inside the container through the tunnel. */
  portUrl(port: number, protocol: 'ws' | 'http'): Promise<string>
  /** Why the gateway stopped on its own (the forwarder exited), once it has. */
  readonly stopped: string | undefined
  close(): void
}

const installCa = (containerId: string, cert: string, signal?: AbortSignal, engine?: Engine) =>
  docker(
    [
      'exec',
      '--interactive',
      ...AS_ROOT,
      containerId,
      'sh',
      '-c',
      `umask 022 && mkdir -p "$(dirname ${CA_PATH})" && cat > ${CA_PATH} && { command -v update-ca-certificates >/dev/null && update-ca-certificates >/dev/null 2>&1 && grep -q "$(sed -n 2p ${CA_PATH})" ${CA_BUNDLE} && echo ${BUNDLED}; true; }`,
    ],
    { input: cert, signal, engine },
  )

/**
 * Starts the egress gateway for one container: a forwarder inside it, tunnelled over one
 * `docker exec -i`, and the proxy in this process, which holds the real credentials.
 */
export async function startGateway(
  containerId: string,
  options: GatewayOptions,
  signal?: AbortSignal,
  engine?: Engine,
): Promise<Gateway> {
  const ca = createCertificateAuthority()
  const installed = await installCa(containerId, ca.cert, signal, engine)
  if (installed.exitCode !== 0) {
    throw new Error(`couldn't install the gateway CA: ${installed.stderr.trim()}`)
  }
  const bundled = installed.stdout.toString('utf8').includes(BUNDLED)
  const proxy = createEgressProxy({ ...options, ca })
  const args = [
    'exec',
    '--interactive',
    ...AS_ROOT,
    containerId,
    'node',
    '-e',
    forwarderScript(PROXY_PORT),
  ]
  const startedAt = Date.now()
  // Own process group, like every docker call: reeval handles Ctrl-C and tears the gateway down.
  const { bin } = engineSpec(engine)
  const child = spawn(bin, args, {
    stdio: 'pipe',
    detached: true,
    env: { ...process.env, ...engineEnv(engine) },
  })
  child.once('close', (code) => traceDocker(args, startedAt, { exitCode: code, stderr }, bin))
  let stderr = ''
  child.stderr.on('data', (d) => {
    stderr += d
  })
  child.stdin.on('error', () => {})
  let closed = false
  let started = false
  const mux = createMux({
    Duplex,
    parity: 0,
    send: (frame) => {
      if (!closed) child.stdin.write(frame)
    },
    onOpen(stream, port) {
      if (port === PROXY_PORT) proxy.handle(stream)
      else stream.destroy()
    },
    onReady: () => {
      started = true
      ready.resolve()
    },
    // The forwarder runs as root, so only a root sandbox could forge its output: a frame that
    // breaks the protocol stops the gateway rather than the worker. Before READY it's a forwarder
    // that never started (a shell's "node: not found"), which its exit or the timeout reports.
    onError: (message) => {
      if (!started) return
      stop(`the forwarder's output broke the protocol: ${message}`)
      child.kill('SIGKILL')
    },
  })
  const ready = {} as { promise: Promise<void>; resolve(): void; reject(error: unknown): void }
  ready.promise = new Promise<void>((resolve, reject) => Object.assign(ready, { resolve, reject }))
  child.stdout.on('data', (chunk: Buffer) => mux.receive(chunk))
  child.once('error', (error) => ready.reject(error))
  const listeners = new Map<number, Promise<net.Server>>()
  const tunnels = new Set<net.Socket>()
  let stopped: string | undefined
  /** Stops on its own: nothing reaches the container any more, so connections are refused. */
  const stop = (reason: string) => {
    const asked = closed
    closed = true
    mux.destroy()
    ready.reject(new Error(reason))
    if (asked) return
    stopped = reason
    for (const socket of tunnels) socket.destroy()
    for (const l of listeners.values()) void l.then((s) => s.close())
  }
  child.once('close', (code) =>
    stop(`the forwarder exited (${code}): ${stderr.trim().slice(-500)}`.replace(/: $/, '')),
  )
  const timer = setTimeout(
    () => ready.reject(new Error(`the forwarder didn't start within ${READY_TIMEOUT_MS / 1000}s`)),
    READY_TIMEOUT_MS,
  )
  const onAbort = () => ready.reject(signal?.reason)
  signal?.addEventListener('abort', onAbort, { once: true })

  const close = () => {
    closed = true
    child.kill('SIGKILL')
    mux.destroy()
    proxy.close()
    for (const l of listeners.values()) void l.then((s) => s.close())
  }
  try {
    await ready.promise
  } catch (error) {
    close()
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }

  const proxyUrl = `http://127.0.0.1:${PROXY_PORT}`
  const noProxy = 'localhost,127.0.0.1,::1'
  return {
    env: {
      HTTPS_PROXY: proxyUrl,
      HTTP_PROXY: proxyUrl,
      https_proxy: proxyUrl,
      http_proxy: proxyUrl,
      NO_PROXY: noProxy,
      no_proxy: noProxy,
      NODE_EXTRA_CA_CERTS: CA_PATH,
      // Node's fetch (22.21+, 24+) honours the proxy variables only with this.
      NODE_USE_ENV_PROXY: '1',
      // Clients with their own trust store (Python requests, curl builds, git) use the system
      // bundle, which now has the gateway's CA; set only when it does.
      ...(bundled
        ? {
            SSL_CERT_FILE: CA_BUNDLE,
            REQUESTS_CA_BUNDLE: CA_BUNDLE,
            CURL_CA_BUNDLE: CA_BUNDLE,
            GIT_SSL_CAINFO: CA_BUNDLE,
          }
        : {}),
    },
    addTransformations: proxy.addTransformations,
    setTransformations: proxy.setTransformations,
    setPolicy: proxy.setPolicy,
    setSubstitutions: proxy.setSubstitutions,
    traffic: proxy.traffic,
    get stopped() {
      return stopped
    },
    async portUrl(port, protocol) {
      if (stopped) throw new Error(`the egress gateway stopped: ${stopped}`)
      let listening = listeners.get(port)
      if (!listening) {
        listening = new Promise((resolve, reject) => {
          const server = net.createServer({ allowHalfOpen: true }, (socket) => {
            if (stopped) return socket.destroy()
            tunnels.add(socket)
            socket.once('close', () => tunnels.delete(socket))
            link(socket, mux.open(port))
          })
          server.once('error', reject)
          server.listen(0, '127.0.0.1', () => resolve(server))
        })
        listeners.set(port, listening)
      }
      const address = (await listening).address() as net.AddressInfo
      return `${protocol}://127.0.0.1:${address.port}`
    },
    close,
  }
}
