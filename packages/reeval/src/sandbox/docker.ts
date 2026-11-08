import { posix } from 'node:path'
import {
  createDockerSession,
  DEFAULT_IMAGE,
  DEFAULT_LIMITS,
  type DockerSession,
  docker,
  type EgressEvent,
  type EgressOptions,
  EgressUnavailableError,
  ENGINES,
  type Engine,
  engineSpec,
  imageInfo,
  isRemoteEngine,
  LABEL,
  type LocalEngine,
  SANDBOX_HOME,
  SANDBOX_ROOT,
  SANDBOX_STATE,
  type SandboxLimits,
  type Substitution,
  WORKSPACE_DIR,
} from '@reeval/sandbox-docker'
import { shellQuote as q } from '@reeval/sandbox-docker/process'
import { type AttemptDebug, attemptDebug } from '../debug/attempt.ts'
import '../debug/docker.ts'
import { egressLabel, gatewayPolicy, isDirect, setupEgress } from '../egress.ts'
import { callUsage, type ModelCall } from '../model-calls.ts'
import type { DockerSandboxDescriptor } from '../types.ts'
import type { SandboxOptions } from './index.ts'
import { type SampleMode, samplerHosts, sharedMeter, startMeter } from './resources.ts'
import { brokeringRefusal, logGateway } from './start.ts'
import { InfraError, type NetworkSandbox, type Sandbox } from './types.ts'

/**
 * Removes every container still labeled with the run: a worker killed by the signal that
 * canceled the run (SIGTERM to the process group) never destroys its sandboxes.
 */
export async function removeRunContainers(
  runId: string,
  engines: readonly LocalEngine[] = ['docker'],
): Promise<void> {
  for (const engine of engines) {
    const r = await docker(['ps', '-aq', '--filter', `label=${LABEL.run}=${runId}`], {
      engine,
    }).catch(() => null)
    const ids = r?.exitCode === 0 ? r.stdout.toString('utf8').split(/\s+/).filter(Boolean) : []
    if (ids.length) await docker([...ENGINES[engine].rmForce, ...ids], { engine }).catch(() => {})
  }
}

/** Distinct gateway warnings an attempt prints before one line says there are more. */
const GATEWAY_WARNINGS = 5

/**
 * The gateway's events as debug lines: one per request, with DNS decisions and headers traced.
 * Refused requests to the harness's expected hosts are traced only; teardown summarizes them.
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
        `dns ${event.host} ${event.allowed ? `→ ${event.addresses?.join(', ')}` : `${event.unresolved ? 'unresolved' : 'refused'}: ${event.reason}`}`,
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

/**
 * What every sandbox behind the egress gateway shares: the gateway's options (policy, brokering,
 * event and warning glue) and the record fields its events fill in.
 */
export function gatewayGlue(options: SandboxOptions) {
  const { brokering, substitutions = [] } = options
  const brokered = [
    ...new Set([...(brokering ? [brokering.credential] : []), ...substitutions.map((s) => s.name)]),
  ]
  const debug = attemptDebug()
  const policy = gatewayPolicy(setupEgress(options.egress))
  const served: string[] = []
  const asked: string[] = []
  const brokeredStatuses: number[] = []
  const servedModel = brokering?.servedModel
  const askedModel = brokering?.askedModel
  const upstream = brokering?.upstream
  const upstreams = new Map<string, number>()
  const calls: ModelCall[] = []
  let cost: number | undefined
  const logEvent = gatewayEvents(debug, brokering?.credential, options.expectedBlocked ?? [])
  const onEvent = (event: EgressEvent) => {
    logEvent?.(event)
    if (event.type === 'dns') return
    const ok = event.status === undefined || (event.status >= 200 && event.status <= 299)
    const request = {
      method: event.method,
      host: event.host,
      path: URL.canParse(event.url) ? new URL(event.url).pathname : event.url,
      ...(event.status !== undefined ? { status: event.status } : {}),
      ...(event.responseModel ? { responseModel: event.responseModel } : {}),
      ...(event.responseEffort ? { responseEffort: event.responseEffort } : {}),
      ...(event.responseProvider ? { responseProvider: event.responseProvider } : {}),
      ...(event.responseCost !== undefined ? { responseCost: event.responseCost } : {}),
      ...(event.requestHeaders ? { headers: event.requestHeaders } : {}),
    }
    // A refused or failed call was served by nothing, whatever it names.
    const model = ok ? servedModel?.(request) : undefined
    if (event.modelCall) {
      calls.push({
        startedAt: Date.now() - event.ms,
        ms: event.ms,
        firstByteMs: event.firstByteMs ?? null,
        request: `${request.method} ${request.host}${request.path}`,
        status: event.status ?? null,
        usage: callUsage(event.responseUsage),
        model: model ?? (ok ? event.usageModel : undefined) ?? null,
        tools: event.requestTools ?? null,
        ...(brokering?.modelStream ? { stream: true as const } : {}),
      })
    }
    if (event.credentials.length === 0) return
    if (event.status !== undefined) brokeredStatuses.push(event.status)
    if (!ok) return
    if (model) served.push(model)
    const wanted = askedModel?.(request)
    if (wanted) asked.push(wanted)
    const by = upstream?.(request)
    if (by) {
      upstreams.set(by.provider, (upstreams.get(by.provider) ?? 0) + 1)
      if (by.costUsd !== undefined) cost = (cost ?? 0) + by.costUsd
    }
  }
  const warned = new Set<string>()
  const warn = (text: string) => {
    if (warned.has(text) || warned.size > GATEWAY_WARNINGS) return
    warned.add(text)
    const shown =
      warned.size > GATEWAY_WARNINGS
        ? 'the egress gateway has more warnings for this attempt, not shown; its egress.blocked lists the requests it refused'
        : text
    if (options.onWarning) options.onWarning(shown)
    else console.warn(`warning: ${shown}`)
  }
  const egress = {
    policy,
    log: process.env.REEVAL_DEBUG ? (line: string) => console.error(line) : undefined,
    onEvent,
    onUnsubstituted: ({ name, where, in: places, method, url }: UnsubstitutedEvent) =>
      warn(
        `the egress gateway sent ${method} ${url} with ${name}'s placeholder in the ${where}, where it isn't substituted: add '${where}' to its in (now ${JSON.stringify(places)}) if the API takes it there`,
      ),
    ...(brokering && {
      endpoints: brokering.endpoints,
      ...(brokering.modelResponses ? { modelResponses: brokering.modelResponses } : {}),
      ...(brokering.modelCalls ? { modelCalls: brokering.modelCalls } : {}),
      ...(brokering.tokens ? { derivedTokens: [brokering.tokens] } : {}),
      ...(brokering.localResponses ? { localResponses: brokering.localResponses } : {}),
      onRefused: ({ method, url }: { method: string; url: string }) =>
        warn(
          `the egress gateway refused ${method} ${url}: it carries ${brokering.credential}'s placeholder and isn't one of the endpoints reeval brokers it for`,
        ),
    }),
  }
  /** The record fields the gateway's events fill in, for a sandbox on `network`. */
  const recorded = (network: DockerSession): Partial<Sandbox> => ({
    ...(network.traffic && network.egress?.active && { traffic: network.traffic }),
    ...(servedModel && {
      servedModels: () => [...new Set(served)],
      servedRequests: () => [...served],
    }),
    ...(askedModel && { askedModels: () => [...new Set(asked)] }),
    ...(upstream && {
      upstreams: () => [...upstreams].map(([provider, calls]) => ({ provider, calls })),
      reportedCostUsd: () => cost,
    }),
    ...(brokering && { brokeredStatuses: () => [...brokeredStatuses] }),
    ...(brokering?.modelCalls && { modelCalls: () => [...calls] }),
    ...(network.setSubstitutions && {
      setSubstitutions: (subs: readonly Substitution[]) =>
        network.setSubstitutions?.(subs) ?? Promise.resolve(),
    }),
    ...(network.setEgress &&
      network.egress?.active && {
        setEgress: async (o: Parameters<NonNullable<Sandbox['setEgress']>>[0]) => {
          debug?.log(
            'container',
            o.direct
              ? `the ${o.phase} phase keeps the container's network`
              : `the ${o.phase} phase has the gateway as its only way out`,
          )
          await network.setEgress?.(o).catch((error: unknown) => {
            throw new InfraError(
              `Couldn't start the ${o.phase} phase's egress: ${(error as Error).message}`,
            )
          })
        },
      }),
  })
  return { brokered, debug, egress, recorded }
}

type UnsubstitutedEvent = Parameters<NonNullable<EgressOptions['onUnsubstituted']>>[0]

/**
 * A sandbox on a harness session: the workspace under the session's default working directory
 * ({@link SANDBOX_ROOT} in a container), the agent's home, and reeval's own privileged execs in
 * `stateDir` ({@link SANDBOX_STATE} unless set).
 */
export async function sessionSandbox(
  network: DockerSession,
  glue: ReturnType<typeof gatewayGlue>,
  options: {
    root?: boolean
    stateDir?: string
    oomKills: Sandbox['oomKills']
    /** What its resources are read from: a container's cgroup, or the whole machine. */
    resources: {
      mode: SampleMode
      machine: { sandbox: string; size?: string; id?: string; name?: string }
      /** Other attempts run on the machine at the same time. */
      shared?: boolean
    }
  },
): Promise<NetworkSandbox> {
  const workdir = posix.join(network.defaultWorkingDirectory, WORKSPACE_DIR)
  const stateDir = options.stateDir ?? SANDBOX_STATE
  await network.run({ command: `mkdir -p ${q(workdir)}` })
  const home = (await network.run({ command: 'printf %s "$HOME"' })).stdout || SANDBOX_HOME
  const resolve = (path: string) =>
    path.startsWith('~/') ? posix.join(home, path.slice(2)) : posix.resolve(workdir, path)
  // A root sandbox's agent is root too, and could swap the binaries a privileged exec runs.
  const execOwn: Sandbox['execOwn'] = async (command, opts) =>
    options.root
      ? network.run({ command, workingDirectory: stateDir, abortSignal: opts?.signal })
      : network.runPrivileged({ command, abortSignal: opts?.signal })
  return {
    workdir,
    home,
    stateDir,
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
    ...glue.recorded(network),
    writeFile: async (path, content) =>
      typeof content === 'string'
        ? network.writeTextFile({ path: resolve(path), content })
        : network.writeBinaryFile({ path: resolve(path), content }),
    getPortEndpoint: async ({ port, protocol = 'http' }) =>
      network.getPortEndpoint({ port, protocol }),
    oomKills: options.oomKills,
    meter: () =>
      (options.resources.shared ? sharedMeter : startMeter)(
        samplerHosts(network),
        options.resources.mode,
        options.resources.machine,
      ),
    destroy: async () => {
      await Promise.resolve(network.destroy()).catch(() => {})
    },
  }
}

export async function createDockerSandbox(
  descriptor: DockerSandboxDescriptor,
  options: SandboxOptions,
): Promise<NetworkSandbox> {
  const image = options.image ?? descriptor.image ?? DEFAULT_IMAGE
  const engine = descriptor.engine ?? 'docker'
  const spec = engineSpec(engine)
  if (!(await imageInfo(image, engine))) {
    throw new InfraError(`${spec.name} image ${image} not found. Build it with: reeval image build`)
  }
  const { root, capabilities, memory, swap, cpus, pids } = descriptor
  return containerSandbox(options, {
    image,
    engine,
    fn: spec.fn,
    ...(root !== undefined && { root }),
    ...(capabilities && { capabilities }),
    limits: {
      ...(memory !== undefined && { memory }),
      ...(swap !== undefined && { swap }),
      ...(cpus !== undefined && { cpus }),
      ...(pids !== undefined && { pids }),
    },
    machine: { sandbox: engine },
  })
}

/**
 * The attempt in a new container of `image` on `engine`, the local CLI or a machine's over SSH,
 * with the egress gateway as its way out: always started, so every attempt's egress is recorded.
 */
export async function containerSandbox(
  options: SandboxOptions,
  o: {
    image: string
    engine: Engine
    /** The helper messages name: `docker`, `boat`. */
    fn: string
    root?: boolean
    capabilities?: string[]
    limits: Partial<SandboxLimits>
    /** The machine its resources are read on, as the record names it. */
    machine: { sandbox: string; size?: string; id?: string; name?: string }
  },
): Promise<NetworkSandbox> {
  const { image, engine, root, limits } = o
  const spec = engineSpec(engine)
  const glue = gatewayGlue(options)
  const { brokered, debug } = glue
  const started = performance.now()
  const nodeHint = `The egress gateway needs Node in the image: start from a Debian or Ubuntu image with ${o.fn}({ from: '${image}' }) or ${o.fn}({ dockerfile }), and reeval adds it.`
  const needsNode = (reason: string) =>
    brokered.length > 0
      ? brokeringRefusal(`${o.fn}()`, brokered, reason, nodeHint)
      : new InfraError(
          `Can't enforce egress ${egressLabel(options.egress) || 'proxy'}: the egress gateway, the sandbox's only way out, could not start (${reason}). ${nodeHint}`,
        )
  const network = await createDockerSession({
    image,
    engine,
    env: options.env,
    ...(root !== undefined && { root }),
    ...(o.capabilities && { capabilities: o.capabilities }),
    limits,
    labels: { [LABEL.run]: options.runId },
    lifetimeMs: options.timeoutMs,
    abortSignal: options.signal,
    // A detached container can't start without the gateway.
    egress: {
      ...glue.egress,
      direct: isDirect(setupEgress(options.egress).policy),
      detachLater: !isDirect(options.egress.policy),
    },
  }).catch((error: unknown) => {
    if (!(error instanceof EgressUnavailableError)) throw error
    throw error.network
      ? new InfraError(
          `Can't enforce egress ${egressLabel(options.egress) || 'proxy'}: ${error.reason}.`,
        )
      : needsNode(error.reason)
  })
  debug?.log(
    'container',
    `created ${network.id.slice(0, 12)} from ${image}${isRemoteEngine(engine) ? ` on ${engine.description}` : ''} in ${Math.round(performance.now() - started)}ms`,
  )
  debug?.log(
    'container',
    `network policy ${egressLabel(options.egress) || 'proxy'}${isDirect(setupEgress(options.egress).policy) ? ` · keeps its ${spec.name} network, so traffic that ignores the proxy goes out directly, unrecorded` : ` · detached from every ${spec.name} network, the gateway is its only way out`}`,
  )
  logGateway(debug, network.egress, brokered)
  if (network.egress?.active === false && brokered.length > 0) {
    await Promise.resolve(network.destroy()).catch(() => {})
    throw needsNode(network.egress.reason)
  }
  return sessionSandbox(network, glue, {
    ...(root !== undefined && { root }),
    resources: { mode: 'container', machine: o.machine },
    oomKills: async () => {
      const kills = await network.oomKills()
      if (kills === null) return null
      const limit = String(limits.memory ?? DEFAULT_LIMITS.memory)
      // Unset swap is as much as memory; any spelling of zero is none.
      const onTop = limits.swap === undefined ? limit : String(limits.swap)
      return { kills, limit, swap: /^0+(\.0+)?[bkmg]?$/i.test(onTop) ? null : onTop }
    },
  })
}
