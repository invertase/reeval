import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { posix } from 'node:path'
import { Readable } from 'node:stream'
import type { HarnessV1NetworkSandboxSession, HarnessV1SandboxProvider } from '@ai-sdk/harness'
import {
  docker,
  dockerCapacity,
  dockerOk,
  removeContainerDetached,
  sweepLabelDetached,
} from './docker-cli.ts'
import { type Gateway, type GatewayOptions, startGateway } from './egress/gateway.ts'
import { isRestricted, type NetworkPolicy } from './egress/policy.ts'
import type { EgressTraffic } from './egress/proxy.ts'
import type { Substitution } from './egress/substitution.ts'
import { type Engine, engineEnv, engineSpec } from './engine.ts'
import { BRIDGE_PORT, LABEL, SANDBOX_HOME, SANDBOX_ROOT, SANDBOX_USER } from './image.ts'
import { shellQuote as q } from './process.ts'
import { traceDocker } from './trace.ts'

/** Starts the egress gateway: credential brokering, and an enforceable network policy. */
export type EgressOptions = Omit<GatewayOptions, 'policy'> & {
  /** Defaults to `allow-all`. Anything else detaches the container from every Docker network. */
  policy?: NetworkPolicy
}

/** A container's resource limits. */
export type SandboxLimits = {
  /** Memory, as Docker takes it: bytes, or a number with `b`, `k`, `m` or `g`. */
  memory: string | number
  /**
   * Swap the container may use on top of `memory`, in the same units; unset is as much as
   * `memory`, and 0 makes `memory` the hard ceiling. A host without swap has none to give.
   */
  swap?: string | number
  /** CPUs, fractional ones allowed; capped at what the Docker host has. */
  cpus: number
  /** Processes and threads at once. */
  pids: number
}

export const DEFAULT_LIMITS: SandboxLimits = { memory: '4g', cpus: 2, pids: 1024 }

const UNITS = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 } as const

/** A Docker memory size in bytes, as Docker reads it (binary units). */
function sizeBytes(size: string | number): number {
  if (typeof size === 'number') return size
  const m = /^(\d+(?:\.\d+)?)([bkmg])?$/i.exec(size.trim())
  if (!m) throw new Error(`not a Docker memory size: ${JSON.stringify(size)}`)
  const unit = (m[2]?.toLowerCase() ?? 'b') as keyof typeof UNITS
  return Math.floor(Number(m[1]) * UNITS[unit])
}

/** Bytes in the largest unit that divides them evenly: `8g`, `1536m`, or plain bytes. */
function formatSize(bytes: number): string {
  for (const unit of ['g', 'm', 'k'] as const) {
    if (bytes % UNITS[unit] === 0) return `${bytes / UNITS[unit]}${unit}`
  }
  return String(bytes)
}

/** Docker's `--memory-swap`: the total of memory and swap. */
export function memorySwap(limits: Pick<SandboxLimits, 'memory' | 'swap'>): string {
  const memory = sizeBytes(limits.memory)
  const swap = limits.swap === undefined ? memory : sizeBytes(limits.swap)
  return swap === 0 ? String(limits.memory) : formatSize(memory + swap)
}

/** What `root` adds back: what `apt-get` (and its `_apt` sandbox) and `dpkg` need as root. */
export const ROOT_CAPABILITIES = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETUID', 'SETGID'] as const

export type SessionOptions = {
  image: string
  labels?: Record<string, string>
  /** Set in the container for every process; values travel via the docker CLI's env, not argv. */
  env?: Record<string, string>
  /** The container removes itself after this long, as a backstop for hard-killed runs. */
  lifetimeMs?: number
  abortSignal?: AbortSignal
  egress?: EgressOptions | boolean
  /**
   * Every process as root with {@link ROOT_CAPABILITIES}, instead of {@link SANDBOX_USER} with
   * none. For evals that install packages at run time.
   */
  root?: boolean
  /** Capabilities to add back (`NET_RAW`, …); every other one is dropped. */
  capabilities?: readonly string[]
  /** Each unset one is {@link DEFAULT_LIMITS}'. */
  limits?: Partial<SandboxLimits>
  /** The container CLI; Docker unless set. */
  engine?: Engine
}

const hostCpus = new Map<Engine, Promise<number | undefined>>()
/** Docker refuses `--cpus` above the host's count, so cap it there. */
async function cpuLimit(cpus: number, engine: Engine = 'docker'): Promise<string> {
  let known = hostCpus.get(engine)
  if (!known) {
    known = dockerCapacity(engine).then(
      (c) => c?.cpus,
      () => undefined,
    )
    hostCpus.set(engine, known)
  }
  const available = await known
  return String(available ? Math.min(cpus, available) : cpus)
}

/**
 * The `docker run` flags that confine the container: its user, capabilities and limits, and on
 * Podman the bridge network and Docker's seccomp profile.
 */
export async function confinementArgs(options: SessionOptions): Promise<string[]> {
  const limits = { ...DEFAULT_LIMITS, ...options.limits }
  const caps = [...(options.root ? ROOT_CAPABILITIES : []), ...(options.capabilities ?? [])]
  return [
    '--user',
    options.root ? '0:0' : SANDBOX_USER,
    '--cap-drop',
    'ALL',
    ...[...new Set(caps)].flatMap((c) => ['--cap-add', c]),
    '--security-opt',
    'no-new-privileges',
    '--memory',
    String(limits.memory),
    '--memory-swap',
    memorySwap(limits),
    '--pids-limit',
    String(limits.pids),
    '--cpus',
    await cpuLimit(limits.cpus, options.engine),
    ...engineSpec(options.engine).runArgs(),
  ]
}

/** Runtime `npm i -g` goes to the sandbox user's own prefix, whose `bin` the images put on PATH. */
const userEnv = (options: SessionOptions): Record<string, string> =>
  options.root ? {} : { NPM_CONFIG_PREFIX: `${SANDBOX_HOME}/.local` }

/** Whether the gateway runs. When it doesn't, the session has no request-transformation methods. */
export type EgressStatus = { active: true } | { active: false; reason: string }

export type DockerSession = HarnessV1NetworkSandboxSession & {
  /** Unset when the session wasn't asked to start the gateway. */
  readonly egress?: EgressStatus
  /** With the gateway: the brokered secrets, each swapped in only on HTTPS to its own hosts. */
  setSubstitutions?(subs: readonly Substitution[]): Promise<void>
  /** With the gateway: the hosts the sandbox contacted and was refused so far. */
  traffic?(): EgressTraffic
  /** Processes the kernel killed at the memory limit so far; `null` when Docker can't say. */
  oomKills(): Promise<number | null>
}

/** Set on every exec, so a kill can find the command's whole process tree in the container. */
const EXEC_MARKER = 'REEVAL_EXEC_ID'

/**
 * The container's cgroup counts every process the kernel killed at its memory limit: cgroup v2's
 * `memory.events` and v1's `memory.oom_control` both have an `oom_kill` line. Without either,
 * Docker's `OOMKilled` says only whether there was one.
 */
export async function oomKills(id: string, engine?: Engine): Promise<number | null> {
  const events = await docker(
    [
      'exec',
      id,
      'sh',
      '-c',
      'cat /sys/fs/cgroup/memory.events 2>/dev/null || cat /sys/fs/cgroup/memory/memory.oom_control',
    ],
    { engine },
  ).catch(() => null)
  const count = events?.stdout.toString('utf8').match(/^oom_kill (\d+)$/m)?.[1]
  if (events?.exitCode === 0 && count !== undefined) return Number(count)
  const inspected = await docker(['inspect', '--format', '{{.State.OOMKilled}}', id], {
    engine,
  }).catch(() => null)
  if (inspected?.exitCode !== 0) return null
  const killed = inspected.stdout.toString('utf8').trim()
  return killed === 'true' ? 1 : killed === 'false' ? 0 : null
}

/** The Docker networks a container is attached to. */
async function networksOf(id: string, engine?: Engine): Promise<string[]> {
  const out = await dockerOk(['inspect', '--format', '{{json .NetworkSettings.Networks}}', id], {
    engine,
  })
  return Object.keys(JSON.parse(out) ?? {})
}

/** How the container is networked when it's on no network: `host`, `slirp4netns`, `pasta`…  */
async function networkMode(id: string, engine?: Engine): Promise<string> {
  const r = await docker(['inspect', '--format', '{{.HostConfig.NetworkMode}}', id], {
    engine,
  }).catch(() => null)
  return r?.exitCode === 0 ? r.stdout.toString('utf8').trim() || 'unknown' : 'unknown'
}

/**
 * A harness sandbox session backed by one local Docker container. Commands and file I/O go
 * through `docker exec`. With the egress gateway, ports are reached through its tunnel whatever
 * the network policy; without it, the bridge port is published on 127.0.0.1.
 */
export async function createDockerSession(options: SessionOptions): Promise<DockerSession> {
  const nonce = randomBytes(8).toString('hex')
  const labels = { [LABEL.managed]: 'true', [LABEL.session]: nonce, ...options.labels }
  const lifetime = Math.ceil((options.lifetimeMs ?? 24 * 3_600_000) / 1000)
  const signal = options.abortSignal
  const { engine } = options
  const spec = engineSpec(engine)
  const env = { ...userEnv(options), ...options.env }
  const id = await dockerOk(
    [
      'run',
      '--detach',
      '--rm',
      '--init',
      ...(await confinementArgs(options)),
      ...Object.entries(labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]),
      ...Object.keys(env).flatMap((k) => ['--env', k]),
      '--publish',
      `127.0.0.1::${BRIDGE_PORT}`,
      ...(spec.createsWorkdir ? ['--workdir', SANDBOX_ROOT] : []),
      '--entrypoint',
      'sleep',
      options.image,
      String(lifetime),
    ],
    { signal, env, engine },
  ).catch((error) => {
    const sweep = () => sweepLabelDetached(`${LABEL.session}=${nonce}`, undefined, engine)
    if (signal?.aborted) sweep()
    // Docker says "unable to find user", Podman "no matching entries in passwd file".
    if (/unable to find user|no matching entries in passwd/i.test((error as Error).message)) {
      sweep()
      throw new Error(
        `${options.image} has no ${SANDBOX_USER} user to run the sandbox as. Images reeval builds have one: rebuild it (reeval image build), or start from reeval's image or ${spec.fn}({ from }). An eval that needs root at run time can opt in with ${spec.fn}({ root: true }).`,
      )
    }
    throw error
  })
  let gateway: Gateway | undefined
  let removed: Promise<void> | undefined
  const remove = () => {
    gateway?.close()
    removed ??= removeContainerDetached(id, engine)
    return removed
  }
  if (signal?.aborted) {
    await remove()
    throw signal.reason
  }
  if (!spec.createsWorkdir) {
    // Podman's `run --workdir` refuses a directory the image doesn't have; Docker makes it.
    const made = await docker(['exec', '--user', '0:0', id, 'mkdir', '-p', SANDBOX_ROOT], {
      engine,
      signal,
    }).catch((error) => ({ exitCode: 1, stderr: (error as Error).message }))
    if (made.exitCode !== 0) {
      await remove()
      if (signal?.aborted) throw signal.reason
      throw new Error(`Couldn't create ${SANDBOX_ROOT} in the container: ${made.stderr.trim()}`)
    }
  }

  const egressOptions = options.egress === true ? {} : options.egress || undefined
  let egress: EgressStatus | undefined
  // Networks the container was detached from, to reattach if the policy opens up again.
  let detached: string[] = []
  const attach = async (policy: NetworkPolicy) => {
    if (isRestricted(policy) && detached.length === 0) {
      detached = await networksOf(id, engine)
      // A container on no network has a route out only in a network mode (`host`, rootless
      // Podman's slirp4netns or pasta) no disconnect can take away.
      const mode = detached.length === 0 ? await networkMode(id, engine) : 'none'
      if (detached.length === 0 && mode !== 'none') {
        throw new Error(
          `the container's network is ${mode}, which ${spec.name} can't detach it from, so a restricted policy would still have a route out`,
        )
      }
      for (const n of detached) {
        await dockerOk(['network', 'disconnect', '--force', n, id], { engine })
      }
    } else if (!isRestricted(policy) && detached.length > 0) {
      for (const n of detached) await dockerOk(['network', 'connect', n, id], { engine })
      detached = []
    }
  }
  if (egressOptions) {
    const { policy = { mode: 'allow-all' }, ...rest } = egressOptions
    try {
      // Before anything but `sleep` runs, so a restricted container never has a route out.
      await attach(policy)
      gateway = await startGateway(id, { ...rest, policy }, signal, engine)
      egress = { active: true }
    } catch (error) {
      if (signal?.aborted || isRestricted(policy)) {
        await remove()
        if (signal?.aborted) throw signal.reason
        throw new Error(`Can't enforce the egress policy: ${(error as Error).message}`)
      }
      egress = { active: false, reason: (error as Error).message }
    }
  }
  const envFor = (env?: Record<string, string>) => (gateway ? { ...gateway.env, ...env } : env)

  let execs = 0
  const execArgs = (
    command: string,
    marker: string,
    cwd?: string,
    env?: Record<string, string>,
  ) => [
    'exec',
    '--interactive',
    '--workdir',
    cwd ? posix.resolve(SANDBOX_ROOT, cwd) : SANDBOX_ROOT,
    '--env',
    `${EXEC_MARKER}=${marker}`,
    ...Object.keys(env ?? {}).flatMap((k) => ['--env', k]),
    id,
    'bash',
    '-c',
    command,
  ]
  const nextMarker = () => `${id.slice(0, 12)}-${++execs}`
  /**
   * Killing the host's `docker exec` client doesn't stop the command in the container, so kill
   * every process there that inherited this exec's marker: the command and all it started.
   */
  const killExec = (marker: string) =>
    docker(
      [
        'exec',
        id,
        'sh',
        '-c',
        `for e in /proc/[0-9]*/environ; do grep -qsxzF ${q(`${EXEC_MARKER}=${marker}`)} "$e" && kill -9 "$(basename "$(dirname "$e")")" 2>/dev/null; done; true`,
      ],
      { engine },
    ).then(
      () => {},
      () => {},
    )

  const run: HarnessV1NetworkSandboxSession['run'] = async (o) => {
    const env = envFor(o.env)
    const marker = nextMarker()
    try {
      const r = await docker(execArgs(o.command, marker, o.workingDirectory, env), {
        env,
        signal: o.abortSignal,
        engine,
      })
      return { exitCode: r.exitCode, stdout: r.stdout.toString('utf8'), stderr: r.stderr }
    } catch (error) {
      if (o.abortSignal?.aborted) await killExec(marker)
      throw error
    }
  }

  const readBinaryFile = async (o: { path: string; abortSignal?: AbortSignal }) => {
    const r = await docker(['exec', id, 'cat', '--', posix.resolve(SANDBOX_ROOT, o.path)], {
      signal: o.abortSignal,
      engine,
    })
    return r.exitCode === 0 ? new Uint8Array(r.stdout) : null
  }

  const writeBinaryFile = async (o: {
    path: string
    content: Uint8Array
    abortSignal?: AbortSignal
  }) => {
    const path = posix.resolve(SANDBOX_ROOT, o.path)
    await dockerOk(
      [
        'exec',
        '--interactive',
        id,
        'sh',
        '-c',
        `mkdir -p ${q(posix.dirname(path))} && cat > ${q(path)}`,
      ],
      { input: Buffer.from(o.content), signal: o.abortSignal, engine },
    )
  }

  const brokering: Partial<HarnessV1NetworkSandboxSession> = gateway
    ? {
        async setNetworkPolicy(policy) {
          gateway?.setPolicy(policy)
          await attach(policy)
        },
        async addRequestTransformations(rules) {
          gateway?.addTransformations(rules)
        },
        async setRequestTransformations(rules) {
          gateway?.setTransformations(rules)
        },
      }
    : {}
  const substituting: Pick<DockerSession, 'setSubstitutions' | 'traffic'> = gateway
    ? {
        async setSubstitutions(subs) {
          gateway?.setSubstitutions(subs)
        },
        traffic: () => (gateway as Gateway).traffic(),
      }
    : {}

  const session: DockerSession = {
    id,
    description: `${spec.name} container ${id.slice(0, 12)} (${options.image})`,
    defaultWorkingDirectory: SANDBOX_ROOT,
    ports: [BRIDGE_PORT],
    get egress(): EgressStatus | undefined {
      if (egress?.active && gateway?.stopped) return { active: false, reason: gateway.stopped }
      return egress
    },
    ...brokering,
    ...substituting,
    oomKills: () => oomKills(id, engine),
    run,
    async spawn(o) {
      const env = envFor(o.env)
      const marker = nextMarker()
      const args = execArgs(o.command, marker, o.workingDirectory, env)
      const startedAt = Date.now()
      const child = spawn(spec.bin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        env: { ...process.env, ...engineEnv(engine), ...env },
      })
      const exited = new Promise<{ exitCode: number }>((resolve) =>
        child.on('close', (code) => {
          traceDocker(args, startedAt, { exitCode: code, stdout: '<streamed>' }, spec.bin)
          resolve({ exitCode: code ?? 1 })
        }),
      )
      const kill = async () => {
        child.kill('SIGKILL')
        await killExec(marker)
      }
      o.abortSignal?.addEventListener('abort', () => void kill(), { once: true })
      return {
        pid: child.pid,
        stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
        stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
        wait: () => exited,
        kill,
      }
    },
    readBinaryFile,
    async readFile(o) {
      const bytes = await readBinaryFile(o)
      return bytes === null
        ? null
        : (Readable.toWeb(Readable.from([bytes])) as ReadableStream<Uint8Array>)
    },
    async readTextFile(o) {
      const bytes = await readBinaryFile(o)
      if (bytes === null) return null
      const text = Buffer.from(bytes).toString('utf8')
      if (o.startLine === undefined && o.endLine === undefined) return text
      return text
        .split('\n')
        .slice((o.startLine ?? 1) - 1, o.endLine)
        .join('\n')
    },
    writeBinaryFile,
    writeTextFile: (o) => writeBinaryFile({ ...o, content: Buffer.from(o.content, 'utf8') }),
    async writeFile(o) {
      const chunks: Uint8Array[] = []
      for await (const chunk of o.content) chunks.push(chunk)
      await writeBinaryFile({ ...o, content: Buffer.concat(chunks) })
    },
    async getPortEndpoint({ port, protocol = 'ws' }) {
      const scheme = protocol === 'ws' ? 'ws' : 'http'
      // The tunnel doesn't depend on the container's networks, which a policy change detaches
      // and reattaches, and Docker Desktop drops published ports on reattach.
      if (gateway?.stopped) {
        throw new Error(
          `Port ${port} of ${id.slice(0, 12)} isn't reachable: the egress gateway stopped: ${gateway.stopped}`,
        )
      }
      if (gateway) return { url: await gateway.portUrl(port, scheme) }
      const mapped = await docker(['port', id, `${port}/tcp`], { engine })
      const hostPort = mapped.stdout.toString('utf8').split('\n')[0]?.split(':').at(-1)
      if (mapped.exitCode !== 0 || !hostPort) {
        const reason = mapped.stderr.trim() || `${spec.name} reports no host port for it`
        throw new Error(`Port ${port} of ${id.slice(0, 12)} isn't reachable: ${reason}`)
      }
      return { url: `${scheme}://127.0.0.1:${hostPort}` }
    },
    async getPortUrl(o) {
      return (await session.getPortEndpoint(o)).url
    },
    stop: remove,
    destroy: remove,
    restricted: () => {
      const { description, readFile, readBinaryFile, readTextFile, writeFile } = session
      const { writeBinaryFile, writeTextFile, spawn, run } = session
      return {
        description,
        readFile,
        readBinaryFile,
        readTextFile,
        writeFile,
        writeBinaryFile,
        writeTextFile,
        spawn,
        run,
      }
    },
  }
  return session
}

/** The session as an AI SDK harness sandbox provider. */
export const dockerSandboxProvider = (options: SessionOptions): HarnessV1SandboxProvider => ({
  specificationVersion: 'harness-sandbox-v1',
  providerId: options.engine === 'podman' ? 'reeval-podman' : 'reeval-docker',
  async createSession(o) {
    const session = await createDockerSession({ ...options, abortSignal: o?.abortSignal })
    await o?.onFirstCreate?.(session, { abortSignal: o.abortSignal })
    return session
  },
})
