import { posix } from 'node:path'
import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness'
import {
  createDockerSession,
  DEFAULT_IMAGE,
  DEFAULT_LIMITS,
  docker,
  type EgressEvent,
  EgressUnavailableError,
  ENGINES,
  type Engine,
  engineSpec,
  imageInfo,
  LABEL,
  SANDBOX_HOME,
  SANDBOX_ROOT,
  SANDBOX_STATE,
  type Substitution,
  WORKSPACE_DIR,
} from '@reeval/sandbox-docker'
import { type AttemptDebug, attemptDebug } from '../debug/attempt.ts'
import '../debug/docker.ts'
import { egressLabel, gatewayPolicy, isDirect } from '../egress.ts'
import type { DockerSandboxDescriptor } from '../types.ts'
import type { SandboxOptions } from './index.ts'
import { InfraError, type Sandbox } from './types.ts'

/**
 * Removes every container still labelled with the run: a worker killed by the signal that
 * cancelled the run (SIGTERM to the process group) never destroys its sandboxes.
 */
export async function removeRunContainers(
  runId: string,
  engines: readonly Engine[] = ['docker'],
): Promise<void> {
  for (const engine of engines) {
    const r = await docker(['ps', '-aq', '--filter', `label=${LABEL.run}=${runId}`], {
      engine,
    }).catch(() => null)
    const ids = r?.exitCode === 0 ? r.stdout.toString('utf8').split(/\s+/).filter(Boolean) : []
    if (ids.length) await docker([...ENGINES[engine].rmForce, ...ids], { engine }).catch(() => {})
  }
}

/** A Docker sandbox also exposes its harness session, so the harness drives the same container. */
export type DockerSandbox = Sandbox & { readonly network: HarnessV1NetworkSandboxSession }

export const isDockerSandbox = (s: Sandbox): s is DockerSandbox => 'network' in s

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
  const engine = descriptor.engine ?? 'docker'
  const spec = engineSpec(engine)
  if (!(await imageInfo(image, engine))) {
    throw new InfraError(`${spec.name} image ${image} not found. Build it with: reeval image build`)
  }
  const { brokering, substitutions = [] } = options
  const brokered = [
    ...new Set([...(brokering ? [brokering.credential] : []), ...substitutions.map((s) => s.name)]),
  ]
  const debug = attemptDebug()
  const policy = gatewayPolicy(options.egress)
  const served: string[] = []
  const asked: string[] = []
  const brokeredStatuses: number[] = []
  const servedModel = brokering?.servedModel
  const askedModel = brokering?.askedModel
  const logEvent = gatewayEvents(debug, brokering?.credential, options.expectedBlocked ?? [])
  const onEvent = (event: EgressEvent) => {
    logEvent?.(event)
    if (event.type === 'dns' || event.credentials.length === 0) return
    if (event.status !== undefined) brokeredStatuses.push(event.status)
    // A refused or failed call was served by nothing, whatever it names.
    if (event.status !== undefined && (event.status < 200 || event.status > 299)) return
    const request = {
      method: event.method,
      host: event.host,
      path: URL.canParse(event.url) ? new URL(event.url).pathname : event.url,
      ...(event.status !== undefined ? { status: event.status } : {}),
      ...(event.responseModel ? { responseModel: event.responseModel } : {}),
      ...(event.responseEffort ? { responseEffort: event.responseEffort } : {}),
      ...(event.requestHeaders ? { headers: event.requestHeaders } : {}),
    }
    const model = servedModel?.(request)
    if (model) served.push(model)
    const wanted = askedModel?.(request)
    if (wanted) asked.push(wanted)
  }
  const started = performance.now()
  const { root, capabilities, memory, swap, cpus, pids } = descriptor
  const needsNode = (reason: string) =>
    brokered.length > 0
      ? `Can't keep ${brokered.join(', ')} out of the sandbox: credential brokering could not start (${reason}). The egress gateway needs Node in the image: start from a Debian or Ubuntu image with ${spec.fn}({ from: '${image}' }) or ${spec.fn}({ dockerfile }), and reeval adds it.`
      : `Can't enforce egress ${egressLabel(options.egress) || 'proxy'}: the egress gateway, the sandbox's only way out, could not start (${reason}). The egress gateway needs Node in the image: start from a Debian or Ubuntu image with ${spec.fn}({ from: '${image}' }) or ${spec.fn}({ dockerfile }), and reeval adds it.`
  const network = await createDockerSession({
    image,
    engine,
    env: options.env,
    ...(root !== undefined && { root }),
    ...(capabilities && { capabilities }),
    limits: {
      ...(memory !== undefined && { memory }),
      ...(swap !== undefined && { swap }),
      ...(cpus !== undefined && { cpus }),
      ...(pids !== undefined && { pids }),
    },
    labels: { [LABEL.run]: options.runId },
    lifetimeMs: options.timeoutMs,
    abortSignal: options.signal,
    // Always, so every attempt's egress is recorded; a detached container can't start without it.
    egress: {
      policy,
      direct: isDirect(options.egress.policy),
      log: process.env.REEVAL_DEBUG ? (line) => console.error(line) : undefined,
      onEvent,
      onUnsubstituted: ({ name, where, in: places, method, url }) =>
        console.warn(
          `warning: the egress gateway sent ${method} ${url} with ${name}'s placeholder in the ${where}, where it isn't substituted: add '${where}' to its in (now ${JSON.stringify(places)}) if the API takes it there`,
        ),
      ...(brokering && {
        endpoints: brokering.endpoints,
        ...(brokering.modelResponses ? { modelResponses: brokering.modelResponses } : {}),
        ...(brokering.tokens ? { derivedTokens: [brokering.tokens] } : {}),
        onRefused: ({ method, url }) =>
          console.warn(
            `warning: the egress gateway refused ${method} ${url}: it carries ${brokering.credential}'s placeholder and isn't one of the endpoints reeval brokers it for`,
          ),
      }),
    },
  }).catch((error: unknown) => {
    throw error instanceof EgressUnavailableError ? new InfraError(needsNode(error.reason)) : error
  })
  debug?.log(
    'container',
    `created ${network.id.slice(0, 12)} from ${image} in ${Math.round(performance.now() - started)}ms`,
  )
  debug?.log(
    'container',
    `network policy ${egressLabel(options.egress) || 'proxy'}${isDirect(options.egress.policy) ? ` · keeps its ${spec.name} network, so traffic that ignores the proxy goes out directly, unrecorded` : ` · detached from every ${spec.name} network, the gateway is its only way out`}`,
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
    throw new InfraError(needsNode(network.egress.reason))
  }
  const workdir = posix.join(SANDBOX_ROOT, WORKSPACE_DIR)
  await network.run({ command: `mkdir -p ${workdir}` })
  const home = (await network.run({ command: 'printf %s "$HOME"' })).stdout || SANDBOX_HOME
  const resolve = (path: string) =>
    path.startsWith('~/') ? posix.join(home, path.slice(2)) : posix.resolve(workdir, path)
  // A root container's agent is root too, and could swap the binaries a privileged exec runs.
  const execOwn: Sandbox['execOwn'] = async (command, opts) =>
    root
      ? network.run({ command, workingDirectory: SANDBOX_STATE, abortSignal: opts?.signal })
      : network.runPrivileged({ command, abortSignal: opts?.signal })

  return {
    workdir,
    home,
    stateDir: SANDBOX_STATE,
    execOwn,
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
    ...(servedModel && {
      servedModels: () => [...new Set(served)],
      servedRequests: () => [...served],
    }),
    ...(askedModel && { askedModels: () => [...new Set(asked)] }),
    ...(brokering && { brokeredStatuses: () => [...brokeredStatuses] }),
    ...(network.setSubstitutions && {
      setSubstitutions: (subs: readonly Substitution[]) =>
        network.setSubstitutions?.(subs) ?? Promise.resolve(),
    }),
    writeFile: async (path, content) =>
      typeof content === 'string'
        ? network.writeTextFile({ path: resolve(path), content })
        : network.writeBinaryFile({ path: resolve(path), content }),
    getPortEndpoint: async ({ port, protocol = 'http' }) =>
      network.getPortEndpoint({ port, protocol }),
    oomKills: async () => {
      const kills = await network.oomKills()
      if (kills === null) return null
      const limit = String(memory ?? DEFAULT_LIMITS.memory)
      // Unset swap is as much as memory; any spelling of zero is none.
      const onTop = swap === undefined ? limit : String(swap)
      return { kills, limit, swap: /^0+(\.0+)?[bkmg]?$/i.test(onTop) ? null : onTop }
    },
    destroy: async () => {
      await Promise.resolve(network.destroy()).catch(() => {})
    },
  }
}
