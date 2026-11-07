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
import { containerTransport } from './egress/transport.ts'
import { type Engine, engineEnv, engineSpec } from './engine.ts'
import {
  BRIDGE_PORT,
  LABEL,
  SANDBOX_HOME,
  SANDBOX_ROOT,
  SANDBOX_STATE,
  SANDBOX_USER,
} from './image.ts'
import { shellQuote as q } from './process.ts'
import { traceDocker } from './trace.ts'

/** Starts the egress gateway: credential brokering, and an enforceable network policy. */
export type EgressOptions = Omit<GatewayOptions, 'policy'> & {
  /** Defaults to `allow-all`. */
  policy?: NetworkPolicy
  /**
   * Under `allow-all`, keep the container on its Docker networks, so traffic that ignores the
   * proxy (raw TCP and UDP, SSH, database drivers) goes out directly: unfiltered and unrecorded.
   * Otherwise the container is detached from every network and the gateway is its only way out.
   */
  direct?: boolean
  /** A later `setEgress` detaches it: refuse a network mode no disconnect takes away now. */
  detachLater?: boolean
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

/**
 * Every container's capabilities, for {@link DockerSession.runPrivileged}'s root execs: reading
 * and owning any file. The container's own process is root, and each exec names its user: an
 * exec as {@link SANDBOX_USER} holds none of them, and `no-new-privileges` keeps it from gaining
 * them. Podman gives a container's non-root user its added capabilities as ambient ones, which is
 * why the container itself isn't {@link SANDBOX_USER}.
 */
export const PRIVILEGED_CAPABILITIES = [
  'CHOWN',
  'DAC_OVERRIDE',
  'DAC_READ_SEARCH',
  'FOWNER',
] as const

/** The user each of the sandbox's own execs runs as. */
const execUser = (options: Pick<SessionOptions, 'root'>) => (options.root ? '0:0' : SANDBOX_USER)

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
  /**
   * Capabilities to add back (`NET_RAW`, …) on top of {@link PRIVILEGED_CAPABILITIES}; every
   * other one is dropped.
   */
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
 * The `docker run` flags that confine the container: its capabilities and limits, and on Podman
 * the bridge network and Docker's seccomp profile. Its own process is root's `sleep`; every exec
 * names its user.
 */
export async function confinementArgs(options: SessionOptions): Promise<string[]> {
  const limits = { ...DEFAULT_LIMITS, ...options.limits }
  const caps = [
    ...PRIVILEGED_CAPABILITIES,
    ...(options.root ? ROOT_CAPABILITIES : []),
    ...(options.capabilities ?? []),
  ]
  return [
    '--user',
    '0:0',
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

/**
 * Runtime `npm i -g` goes to the sandbox user's own prefix, whose `bin` the images put on PATH.
 * npm's and pnpm's update checks stay off: the image pins both, and pnpm checks
 * `registry.npmjs.org/pnpm` on any install a day after the image's last check (a harness
 * bootstrap's frozen install included), which `deny-all` would record as a blocked host.
 */
const userEnv = (options: SessionOptions): Record<string, string> => ({
  NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  ...(options.root ? {} : { NPM_CONFIG_PREFIX: `${SANDBOX_HOME}/.local` }),
})

/** Whether the gateway runs. When it doesn't, the session has no request-transformation methods. */
export type EgressStatus = { active: true } | { active: false; reason: string }

/**
 * The gateway didn't start for a detached container, which then has no way out, or the container
 * has a route out no disconnect takes away (`network`): `reason` says why.
 */
export class EgressUnavailableError extends Error {
  readonly reason: string
  readonly network: boolean
  constructor(reason: string, o: { network?: boolean } = {}) {
    super(`Can't enforce the egress policy: ${reason}`)
    this.name = 'EgressUnavailableError'
    this.reason = reason
    this.network = !!o.network
  }
}

export type DockerSession = HarnessV1NetworkSandboxSession & {
  /** Unset when the session wasn't asked to start the gateway. */
  readonly egress?: EgressStatus
  /** With the gateway: the brokered secrets, each swapped in only on HTTPS to its own hosts. */
  setSubstitutions?(subs: readonly Substitution[]): Promise<void>
  /** With the gateway: the hosts the sandbox contacted and was refused so far. */
  traffic?(): EgressTraffic
  /**
   * With the gateway: starts the attempt's next phase under `policy`, tagging later traffic with
   * `phase` and closing open tunnels it refuses. `direct` says whether the container keeps its
   * networks, which `allow-all` and `proxy` both leave to it.
   */
  setEgress?(o: { policy: NetworkPolicy; direct: boolean; phase: string }): Promise<void>
  /** Processes the kernel killed at the memory limit so far; `null` when Docker can't say. */
  oomKills(): Promise<number | null>
  /**
   * Runs `/bin/sh -c command` as root with {@link PRIVILEGED_CAPABILITIES}, under the
   * container's seccomp and AppArmor profiles, so it reads files the sandbox user keeps to
   * itself and writes where that user can't look. For the caller's own fixed commands only: it
   * runs in {@link SANDBOX_STATE}, root's own directory, with only the system's binaries on its
   * PATH and none of the gateway's variables, so a command that works on the workspace names
   * its path.
   */
  runPrivileged(o: {
    command: string
    abortSignal?: AbortSignal
  }): Promise<{ exitCode: number; stdout: string; stderr: string }>
  /** {@link runPrivileged} with the output streamed, until it ends or is killed. */
  spawnPrivileged(o: { command: string }): Promise<Spawned>
  /** Containers only: a sibling that watches this one from outside it. */
  observer?: Observer
}

/** A process whose output the caller reads, and ends. */
export type Spawned = {
  pid: number | undefined
  stdout: ReadableStream<Uint8Array>
  wait(): Promise<{ exitCode: number }>
  kill(): Promise<void>
}

/**
 * A sibling container that reads a container's cgroup from outside: the same image, as `nobody`,
 * with no network, no capabilities and a read-only root, in the host's cgroup namespace, where
 * the cgroup files are read-only. It shares no PID namespace with the container, so nothing in
 * the container can see or signal it. The session removes it with the container.
 */
export type Observer = {
  /** The container it watches: its full id, which names its cgroup. */
  target: string
  /** Starts a sibling running `/bin/sh -c command`. */
  spawn(o: { command: string }): Promise<Spawned>
  /** Runs `/bin/sh -c command` in the sibling `spawn` started last. */
  run(o: {
    command: string
    abortSignal?: AbortSignal
  }): Promise<{ exitCode: number; stdout: string; stderr: string }>
}

/** Root's PATH in a privileged exec: none of the sandbox user's own `bin` directories. */
const SYSTEM_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

/** Set on every exec, so a kill can find the command's whole process tree in the container. */
const EXEC_MARKER = 'REEVAL_EXEC_ID'

/**
 * Every exec that can create a file starts with this. An exec'd process inherits the umask of the
 * engine's shim, not the container's: since Docker 29.6 that's 0000 wherever dockerd starts
 * containerd itself (Docker-in-Docker, rootless, OrbStack), which makes homes, the workspace and
 * everything an agent writes world-writable, and tools such as fx and OpenSSH refuse them.
 */
const EXEC_UMASK = 'umask 022'

/** The exit code of the path scripts below when the path doesn't exist. */
const MISSING = 3
/**
 * POSIX `sh` and `stat -L -c` (coreutils and BusyBox both have it), for any image an eval brings;
 * macOS's BSD `stat` takes `-f %z` instead.
 */
const STAT = `[ -e "$1" ] || exit ${MISSING}
if [ -d "$1" ]; then t=directory; elif [ -f "$1" ]; then t=file; else t=other; fi
s=$(stat -L -c %s -- "$1" 2>/dev/null || stat -L -f %z -- "$1") || exit 1
printf '%s %s' "$t" "$s"`
/**
 * One `<type>\\t<name>` per entry, NUL-separated, since a name can hold a newline. An unreadable
 * directory's glob matches nothing, so it's refused rather than listed as empty.
 */
const LIST = `[ -e "$1" ] || exit ${MISSING}
[ -d "$1" ] || { echo "not a directory" >&2; exit 1; }
ls -a -- "$1" > /dev/null || exit 1
for f in "$1"/* "$1"/.*; do
  n=\${f##*/}
  [ "$n" = . ] || [ "$n" = .. ] && continue
  [ -e "$f" ] || [ -L "$f" ] || continue
  if [ -L "$f" ]; then t=symlink; elif [ -d "$f" ]; then t=directory; elif [ -f "$f" ]; then t=file; else t=other; fi
  printf '%s\\t%s\\0' "$t" "$n"
done`
const DELETE = `[ -e "$1" ] || [ -L "$1" ] || exit ${MISSING}
[ -d "$1" ] && [ ! -L "$1" ] && { echo "is a directory" >&2; exit 1; }
rm -f -- "$1"`

/** Runs a path script with `sh` in the sandbox, the absolute path as `$1`. */
type PathExec = (
  script: string,
  path: string,
  abortSignal?: AbortSignal,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>

/**
 * A session's `stat`, `listDirectory` and `deleteFile` from one way to run the path scripts: each
 * gets `null` when the script exits {@link MISSING} (no such path), and any other failure rejects
 * with its stderr. A relative path is under `root`.
 */
export function pathOperations(
  exec: PathExec,
  root = SANDBOX_ROOT,
): Pick<DockerSession, 'stat' | 'listDirectory' | 'deleteFile'> {
  const onPath = async (script: string, o: { path: string; abortSignal?: AbortSignal }) => {
    const path = posix.resolve(root, o.path)
    const r = await exec(script, path, o.abortSignal)
    if (r.exitCode === MISSING) return null
    if (r.exitCode !== 0) throw new Error(`${path}: ${r.stderr.trim() || `exit ${r.exitCode}`}`)
    return r.stdout
  }
  return {
    async stat(o) {
      const out = await onPath(STAT, o)
      if (out === null) return null
      const [type, size] = out.trim().split(' ')
      return { type: type as 'file' | 'directory' | 'other', size: Number(size) }
    },
    async listDirectory(o) {
      const out = await onPath(LIST, o)
      if (out === null) return null
      return out
        .split('\0')
        .filter(Boolean)
        .map((line) => {
          const tab = line.indexOf('\t')
          return {
            type: line.slice(0, tab) as 'file' | 'directory' | 'symlink' | 'other',
            name: line.slice(tab + 1),
          }
        })
    },
    async deleteFile(o) {
      return (await onPath(DELETE, o)) !== null
    },
  }
}

/**
 * The container's cgroup counts every process the kernel killed at its memory limit: cgroup v2's
 * `memory.events` and v1's `memory.oom_control` both have an `oom_kill` line. Without either,
 * Docker's `OOMKilled` says only whether there was one.
 */
export async function oomKills(
  id: string,
  engine?: Engine,
  user: string = SANDBOX_USER,
): Promise<number | null> {
  const events = await docker(
    [
      'exec',
      '--user',
      user,
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
    if (signal?.aborted) sweepLabelDetached(`${LABEL.session}=${nonce}`, undefined, engine)
    throw error
  })
  let gateway: Gateway | undefined
  let removed: Promise<void> | undefined
  const observers: string[] = []
  const remove = () => {
    gateway?.close()
    removed ??= Promise.all([id, ...observers].map((c) => removeContainerDetached(c, engine))).then(
      () => {},
    )
    return removed
  }
  if (signal?.aborted) {
    await remove()
    throw signal.reason
  }
  const NO_USER = 'reeval:no-sandbox-user'
  const setup = [
    EXEC_UMASK,
    ...(options.root
      ? []
      : [`{ id -u ${SANDBOX_USER} >/dev/null 2>&1 || { echo ${NO_USER}; exit 1; }; }`]),
    // Podman's `run --workdir` refuses a directory the image doesn't have; Docker makes it.
    ...(spec.createsWorkdir ? [] : [`mkdir -p ${SANDBOX_ROOT}`]),
    `mkdir -p ${SANDBOX_STATE} && chown 0:0 ${SANDBOX_STATE} && chmod 700 ${SANDBOX_STATE}`,
  ]
  const made = await docker(['exec', '--user', '0:0', id, '/bin/sh', '-c', setup.join(' && ')], {
    engine,
    signal,
  }).catch((error) => ({ exitCode: 1, stdout: Buffer.alloc(0), stderr: (error as Error).message }))
  if (made.exitCode !== 0) {
    await remove()
    if (signal?.aborted) throw signal.reason
    if (made.stdout.toString('utf8').includes(NO_USER)) {
      throw new Error(
        `${options.image} has no ${SANDBOX_USER} user to run the sandbox as. Images reeval builds have one: rebuild it (reeval image build), or start from reeval's image or ${spec.fn}({ from }). An eval that needs root at run time can opt in with ${spec.fn}({ root: true }).`,
      )
    }
    throw new Error(`Couldn't set up the container: ${made.stderr.trim()}`)
  }

  const egressOptions = options.egress === true ? {} : options.egress || undefined
  let egress: EgressStatus | undefined
  let directNow = !!egressOptions?.direct
  const direct = (policy: NetworkPolicy) => directNow && !isRestricted(policy)
  // Networks the container was detached from, to reattach if the policy opens up again.
  let detached: string[] = []
  /**
   * Its networks, or a throw when it has a route out that no disconnect can take away: the host's
   * network (Docker lists it as one, Podman as a mode) or rootless Podman's slirp4netns or pasta.
   */
  const detachable = async () => {
    const networks = await networksOf(id, engine)
    const mode = networks.includes('host')
      ? 'host'
      : networks.length === 0
        ? await networkMode(id, engine)
        : 'none'
    if (mode !== 'none') {
      throw new EgressUnavailableError(
        `the container's network is ${mode}, which ${spec.name} can't detach it from, so traffic around the gateway would still have a route out`,
        { network: true },
      )
    }
    return networks
  }
  const attach = async (policy: NetworkPolicy) => {
    if (!direct(policy) && detached.length === 0) {
      detached = await detachable()
      for (const n of detached) {
        await dockerOk(['network', 'disconnect', '--force', n, id], { engine })
      }
    } else if (direct(policy) && detached.length > 0) {
      for (const n of detached) await dockerOk(['network', 'connect', n, id], { engine })
      detached = []
    }
  }
  if (egressOptions) {
    const { policy = { mode: 'allow-all' }, direct: _, detachLater, ...rest } = egressOptions
    try {
      // Before anything but `sleep` runs, so a detached container never has a route out.
      await attach(policy)
      if (detachLater && direct(policy)) await detachable()
      gateway = await startGateway(containerTransport(id, engine), { ...rest, policy }, signal)
      egress = { active: true }
    } catch (error) {
      // Only a direct container no later phase detaches has a way out without the gateway.
      if (signal?.aborted || !direct(policy) || detachLater) {
        await remove()
        if (signal?.aborted) throw signal.reason
        if (error instanceof EgressUnavailableError) throw error
        throw new EgressUnavailableError((error as Error).message)
      }
      egress = { active: false, reason: (error as Error).message }
    }
  }
  const envFor = (env?: Record<string, string>) => (gateway ? { ...gateway.env, ...env } : env)

  const user = ['--user', execUser(options)]
  let execs = 0
  const execArgs = (
    command: string,
    marker: string,
    cwd?: string,
    env?: Record<string, string>,
  ) => [
    'exec',
    '--interactive',
    ...user,
    '--workdir',
    cwd ? posix.resolve(SANDBOX_ROOT, cwd) : SANDBOX_ROOT,
    '--env',
    `${EXEC_MARKER}=${marker}`,
    ...Object.keys(env ?? {}).flatMap((k) => ['--env', k]),
    id,
    'bash',
    '-c',
    // On the command's own first line, so bash's `line N:` in its errors stays the command's.
    `${EXEC_UMASK}; ${command}`,
  ]
  const nextMarker = () => `${id.slice(0, 12)}-${++execs}`
  /**
   * Killing the host's `docker exec` client doesn't stop the command in the container, so kill
   * every process there that inherited this exec's marker: the command and all it started.
   */
  const killExec = (marker: string, asRoot = false) =>
    docker(
      [
        'exec',
        ...(asRoot ? ['--user', '0:0', '--env', `PATH=${SYSTEM_PATH}`] : user),
        id,
        '/bin/sh',
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

  const runPrivileged: DockerSession['runPrivileged'] = async (o) => {
    const marker = nextMarker()
    const args = [
      'exec',
      '--user',
      '0:0',
      '--workdir',
      SANDBOX_STATE,
      '--env',
      `${EXEC_MARKER}=${marker}`,
      '--env',
      `PATH=${SYSTEM_PATH}`,
      id,
      '/bin/sh',
      '-c',
      `${EXEC_UMASK}; ${o.command}`,
    ]
    try {
      const r = await docker(args, { signal: o.abortSignal, engine })
      return { exitCode: r.exitCode, stdout: r.stdout.toString('utf8'), stderr: r.stderr }
    } catch (error) {
      if (o.abortSignal?.aborted) await killExec(marker, true)
      throw error
    }
  }

  /** Runs the engine's CLI with its output streamed; `stop` ends what it started. */
  const streamed = (args: string[], stop: () => Promise<void>): Spawned => {
    const startedAt = Date.now()
    const child = spawn(spec.bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: { ...process.env, ...engineEnv(engine) },
    })
    child.stderr.resume()
    const exited = new Promise<{ exitCode: number }>((resolve) => {
      child.once('error', () => resolve({ exitCode: 127 }))
      child.once('close', (code) => {
        traceDocker(args, startedAt, { exitCode: code, stdout: '<streamed>' }, spec.bin)
        resolve({ exitCode: code ?? 1 })
      })
    })
    return {
      pid: child.pid,
      stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      wait: () => exited,
      kill: async () => {
        child.kill('SIGKILL')
        await stop()
      },
    }
  }

  const spawnPrivileged: DockerSession['spawnPrivileged'] = async (o) => {
    const marker = nextMarker()
    return streamed(
      [
        'exec',
        '--user',
        '0:0',
        '--workdir',
        SANDBOX_STATE,
        '--env',
        `${EXEC_MARKER}=${marker}`,
        '--env',
        `PATH=${SYSTEM_PATH}`,
        id,
        '/bin/sh',
        '-c',
        o.command,
      ],
      () => killExec(marker, true),
    )
  }

  const observer: Observer = {
    target: id,
    async spawn(o) {
      if (removed) throw new Error(`${spec.name} container ${id.slice(0, 12)} is gone`)
      const name = `reeval-observer-${nonce}-${observers.length + 1}`
      observers.push(name)
      const args = [
        'run',
        '--rm',
        '--name',
        name,
        ...Object.entries(labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]),
        '--pull',
        'never',
        '--network',
        'none',
        '--cgroupns',
        'host',
        '--user',
        '65534:65534',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--read-only',
        '--pids-limit',
        '16',
        '--entrypoint',
        '/bin/sh',
        options.image,
        '-c',
        o.command,
      ]
      return streamed(args, () => removeContainerDetached(name, engine))
    },
    async run(o) {
      const name = observers.at(-1)
      if (!name) return { exitCode: 1, stdout: '', stderr: 'no observer started' }
      const r = await docker(['exec', name, '/bin/sh', '-c', o.command], {
        signal: o.abortSignal,
        engine,
      })
      return { exitCode: r.exitCode, stdout: r.stdout.toString('utf8'), stderr: r.stderr }
    },
  }

  const readBinaryFile = async (o: { path: string; abortSignal?: AbortSignal }) => {
    const r = await docker(
      ['exec', ...user, id, 'cat', '--', posix.resolve(SANDBOX_ROOT, o.path)],
      { signal: o.abortSignal, engine },
    )
    return r.exitCode === 0 ? new Uint8Array(r.stdout) : null
  }

  const paths = pathOperations(async (script, path, abortSignal) => {
    const r = await docker(['exec', ...user, id, 'sh', '-c', script, 'sh', path], {
      signal: abortSignal,
      engine,
    })
    return { exitCode: r.exitCode, stdout: r.stdout.toString('utf8'), stderr: r.stderr }
  })

  const writeBinaryFile = async (o: {
    path: string
    content: Uint8Array
    abortSignal?: AbortSignal
  }) => {
    const path = posix.resolve(SANDBOX_ROOT, o.path)
    const make = `${EXEC_UMASK} && mkdir -p ${q(posix.dirname(path))}`
    // Given a stdin that is at EOF before it attaches, `docker exec --interactive` now and then
    // never passes the EOF on, and `cat` waits forever: an empty file is made without stdin.
    if (o.content.byteLength === 0) {
      await dockerOk(['exec', ...user, id, 'sh', '-c', `${make} && : > ${q(path)}`], {
        signal: o.abortSignal,
        engine,
      })
      return
    }
    await dockerOk(
      ['exec', '--interactive', ...user, id, 'sh', '-c', `${make} && cat > ${q(path)}`],
      {
        input: Buffer.from(o.content),
        signal: o.abortSignal,
        engine,
      },
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
  const substituting: Pick<DockerSession, 'setSubstitutions' | 'traffic' | 'setEgress'> = gateway
    ? {
        async setSubstitutions(subs) {
          gateway?.setSubstitutions(subs)
        },
        async setEgress({ policy, direct: keeps, phase }) {
          directNow = keeps
          // Off the networks before the gateway lets anything new through under the next policy.
          if (!direct(policy)) await attach(policy)
          await gateway?.switchPolicy(policy, phase)
          if (direct(policy)) await attach(policy)
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
    oomKills: () => oomKills(id, engine, execUser(options)),
    run,
    runPrivileged,
    spawnPrivileged,
    observer,
    // The overloads type a `stdin: true` spawn's writable stdin, which this one refuses.
    spawn: (async (o: Parameters<DockerSession['spawn']>[0]) => {
      if (o.stdin) throw new Error(`A ${spec.name} sandbox process has no writable stdin`)
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
    }) as unknown as DockerSession['spawn'],
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
    ...paths,
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
      const { writeBinaryFile, writeTextFile, stat, listDirectory, deleteFile, spawn, run } =
        session
      return {
        description,
        readFile,
        readBinaryFile,
        readTextFile,
        writeFile,
        writeBinaryFile,
        writeTextFile,
        stat,
        listDirectory,
        deleteFile,
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
