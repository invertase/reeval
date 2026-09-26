import { posix } from 'node:path'
import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness'
import {
  createDockerSession,
  DEFAULT_IMAGE,
  type EgressEvent,
  imageInfo,
  LABEL,
  type NetworkPolicy,
  SANDBOX_ROOT,
  type Substitution,
  WORKSPACE_DIR,
} from '@evalsuite/sandbox-docker'
import { type AttemptDebug, attemptDebug } from '../debug/attempt.ts'
import '../debug/docker.ts'
import { allowedHosts, egressLabel } from '../egress.ts'
import type { DockerSandboxDescriptor, PlannedEgress } from '../types.ts'
import type { SandboxOptions } from './index.ts'
import { InfraError, type Sandbox } from './types.ts'

/** A Docker sandbox also exposes its harness session, so the harness drives the same container. */
export type DockerSandbox = Sandbox & { readonly network: HarnessV1NetworkSandboxSession }

export const isDockerSandbox = (s: Sandbox): s is DockerSandbox => 'network' in s

/** `deny-all` when a restricted policy allows no host at all, else an allowlist. */
function networkPolicy(egress: PlannedEgress): NetworkPolicy {
  const hosts = allowedHosts(egress)
  if (hosts === null) return { mode: 'allow-all' }
  return hosts.length ? { mode: 'custom', allowedHosts: hosts } : { mode: 'deny-all' }
}

/**
 * The gateway's events as debug lines: one per request, with DNS decisions and headers traced.
 * Refused requests to the harness's expected hosts are traced only; teardown summarises them.
 */
function gatewayEvents(
  debug: AttemptDebug | undefined,
  credential: string | undefined,
  expected: readonly string[],
) {
  if (!debug) return undefined
  return (event: EgressEvent) => {
    if (event.type === 'dns') {
      debug.trace(
        'gateway',
        'dns',
        event,
        `dns ${event.host} ${event.allowed ? `→ ${event.address}` : `refused: ${event.reason}`}`,
      )
      return
    }
    const { requestHeaders, responseHeaders, type: _, credentials, ...rest } = event
    const substituted = [
      ...rest.substituted,
      ...(credentials.length && credential ? [`${credential} (${credentials.join(', ')})`] : []),
    ]
    debug.request(
      { at: new Date(Date.now() - event.ms).toISOString(), ...rest, substituted },
      { request: requestHeaders, response: responseHeaders },
      !rest.allowed && expected.includes(rest.host),
    )
    for (const name of substituted) {
      debug.log('broker', `substituted ${name} for ${event.host} (${event.method} ${event.url})`)
    }
  }
}

export async function createDockerSandbox(
  descriptor: DockerSandboxDescriptor,
  options: SandboxOptions,
): Promise<DockerSandbox> {
  const image = options.image ?? descriptor.image ?? DEFAULT_IMAGE
  if (!(await imageInfo(image))) {
    throw new InfraError(`Docker image ${image} not found. Build it with: es image build`)
  }
  const { brokering, substitutions = [] } = options
  const brokered = [
    ...new Set([...(brokering ? [brokering.credential] : []), ...substitutions.map((s) => s.name)]),
  ]
  const debug = attemptDebug()
  const policy = networkPolicy(options.egress)
  const started = performance.now()
  const network = await createDockerSession({
    image,
    env: options.env,
    labels: { [LABEL.run]: options.runId },
    lifetimeMs: options.timeoutMs,
    abortSignal: options.signal,
    // Always, so every attempt's egress is recorded; a restricted policy can't start without it.
    egress: {
      policy,
      log: process.env.ES_DEBUG ? (line) => console.error(line) : undefined,
      onEvent: gatewayEvents(debug, brokering?.credential, options.expectedBlocked ?? []),
      onUnsubstituted: ({ name, where, in: places, method, url }) =>
        console.warn(
          `warning: the egress gateway sent ${method} ${url} with ${name}'s placeholder in the ${where}, where it isn't substituted: add '${where}' to its in (now ${JSON.stringify(places)}) if the API takes it there`,
        ),
      ...(brokering && {
        endpoints: brokering.endpoints,
        ...(brokering.tokens ? { derivedTokens: [brokering.tokens] } : {}),
        onRefused: ({ method, url }) =>
          console.warn(
            `warning: the egress gateway refused ${method} ${url}: it carries ${brokering.credential}'s placeholder and isn't one of the endpoints ES brokers it for`,
          ),
      }),
    },
  })
  debug?.log(
    'container',
    `created ${network.id.slice(0, 12)} from ${image} in ${Math.round(performance.now() - started)}ms`,
  )
  debug?.log(
    'container',
    `network policy ${egressLabel(options.egress) || 'allow-all'}${policy.mode === 'allow-all' ? ' · keeps its Docker network' : ' · detached from every Docker network, the gateway is its only way out'}`,
  )
  debug?.log(
    'container',
    network.egress?.active
      ? `egress gateway started · brokers ${brokered.join(', ') || 'nothing'}`
      : `egress gateway not running: ${network.egress?.reason ?? 'not asked for'}`,
  )
  // Brokered values never enter the container: with no gateway to swap them in, the attempt can't start.
  if (network.egress?.active === false && brokered.length > 0) {
    await Promise.resolve(network.destroy()).catch(() => {})
    throw new InfraError(
      `Can't keep ${brokered.join(', ')} out of the sandbox: credential brokering could not start (${network.egress.reason}). The egress gateway needs Node in the image: start from a Debian or Ubuntu image with docker({ from: '${image}' }) or docker({ dockerfile }), and ES adds it.`,
    )
  }
  const workdir = posix.join(SANDBOX_ROOT, WORKSPACE_DIR)
  await network.run({ command: `mkdir -p ${workdir}` })
  const home = (await network.run({ command: 'printf %s "$HOME"' })).stdout || '/root'
  const resolve = (path: string) =>
    path.startsWith('~/') ? posix.join(home, path.slice(2)) : posix.resolve(workdir, path)

  return {
    workdir,
    home,
    network,
    exec: async (command, opts) =>
      network.run({
        command,
        workingDirectory: opts?.cwd ? posix.resolve(workdir, opts.cwd) : workdir,
        ...(opts?.env ? { env: opts.env } : {}),
        abortSignal: opts?.signal,
      }),
    readFile: async (path) => (await network.readTextFile({ path: resolve(path) })) ?? null,
    ...(network.traffic && network.egress?.active && { traffic: network.traffic }),
    ...(network.setSubstitutions && {
      setSubstitutions: (subs: readonly Substitution[]) =>
        network.setSubstitutions?.(subs) ?? Promise.resolve(),
    }),
    writeFile: async (path, content) =>
      typeof content === 'string'
        ? network.writeTextFile({ path: resolve(path), content })
        : network.writeBinaryFile({ path: resolve(path), content }),
    destroy: async () => {
      await Promise.resolve(network.destroy()).catch(() => {})
    },
  }
}
