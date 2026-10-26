import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The container CLI a sandbox runs on. Podman takes Docker's commands, so one core drives both;
 * {@link ENGINES} holds where they differ.
 */
export type Engine = 'docker' | 'podman'

export type EngineSpec = {
  /** The CLI on PATH. */
  bin: string
  /** For messages: `Docker`, `Podman`. */
  name: string
  /** The function an eval names its sandbox with: `docker`, `podman`. */
  fn: string
  /** `info --format` for the server version and the OS containers run. */
  stateFormat: string
  /** `info --format` for the CPUs and memory containers get. */
  capacityFormat: string
  /** The image id's field in `image inspect` templates. */
  imageId: string
  /** `rm` of running containers, without a grace period. */
  rmForce: string[]
  /** `run` flags every sandbox gets on this engine. */
  runArgs(): string[]
  /** Whether `run --workdir` creates the directory when the image lacks it. */
  createsWorkdir: boolean
}

/**
 * Docker's default seccomp profile, copied unmodified from moby/profiles (Apache-2.0),
 * seccomp/default.json at 6fe7deb1b9fb7c0397a4593480d7d22b9ee8caef. Podman gets it on every
 * container, so a sandbox there refuses the same syscalls (unshare, mount, keyctl…) as on Docker.
 */
const DOCKER_SECCOMP_PROFILE = new URL('../docker/seccomp-default.json', import.meta.url)

let seccompFile: string | undefined
/**
 * Docker's default seccomp profile as a file Podman can read, written once per content under the
 * temp directory (a compiled reeval has no real file of its own to point at).
 */
export function dockerSeccompFile(): string {
  if (seccompFile && existsSync(seccompFile)) return seccompFile
  const json = readFileSync(DOCKER_SECCOMP_PROFILE, 'utf8')
  const hash = createHash('sha256').update(json).digest('hex').slice(0, 16)
  const path = join(tmpdir(), `reeval-seccomp-${hash}.json`)
  if (!existsSync(path)) {
    const partial = `${path}.${process.pid}.tmp`
    writeFileSync(partial, json)
    renameSync(partial, path)
  }
  seccompFile = path
  return path
}

export const ENGINES: Record<Engine, EngineSpec> = {
  docker: {
    bin: 'docker',
    name: 'Docker',
    fn: 'docker',
    stateFormat: '{{.ServerVersion}} {{.OSType}}',
    capacityFormat: '{{.NCPU}} {{.MemTotal}}',
    imageId: '.Id',
    rmForce: ['rm', '-f'],
    runArgs: () => [],
    createsWorkdir: true,
  },
  podman: {
    bin: 'podman',
    name: 'Podman',
    fn: 'podman',
    stateFormat: '{{.Version.Version}} {{.Host.OS}}',
    capacityFormat: '{{.Host.CPUs}} {{.Host.MemTotal}}',
    imageId: '.ID',
    // Podman waits out the stop timeout (10s) before killing, even with -f.
    rmForce: ['rm', '-f', '--time', '0'],
    // Rootless Podman's default network is a mode (slirp4netns, pasta), not a network a policy can
    // detach the container from; on the bridge, `network disconnect` leaves no route out. Podman's
    // own seccomp profile lets a process unshare a user and network namespace, Docker's doesn't.
    runArgs: () => ['--network', 'bridge', '--security-opt', `seccomp=${dockerSeccompFile()}`],
    createsWorkdir: false,
  },
}

export const engineSpec = (engine: Engine = 'docker'): EngineSpec => ENGINES[engine]

type MachineInspect = {
  Name?: string
  ConnectionInfo?: { PodmanSocket?: { Path?: string }; PodmanPipe?: { Path?: string } }
}
type Connection = { Name?: string; Default?: boolean }

/**
 * The `CONTAINER_HOST` that reaches a `podman machine` straight through its API socket (macOS) or
 * named pipe (Windows), from `podman machine inspect`'s JSON.
 */
export function machineHost(
  inspect: unknown,
  platform: NodeJS.Platform,
): { host: string; path: string; name: string } | null {
  const machine = (Array.isArray(inspect) ? inspect[0] : undefined) as MachineInspect | undefined
  const info = machine?.ConnectionInfo
  const name = machine?.Name ?? 'podman-machine-default'
  if (platform === 'darwin' && info?.PodmanSocket?.Path) {
    const path = info.PodmanSocket.Path
    return { host: `unix://${path}`, path, name }
  }
  if (platform === 'win32' && info?.PodmanPipe?.Path) {
    const path = info.PodmanPipe.Path
    return { host: `npipe://${path.replaceAll('\\', '/')}`, path, name }
  }
  return null
}

export type PodmanHostInputs = {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  /** `podman machine inspect`'s JSON, or undefined when it failed. */
  inspect: () => unknown
  /** `podman system connection list --format json`'s JSON, or undefined when it failed. */
  connections: () => unknown
  exists: (path: string) => boolean
}

/**
 * The environment every podman command gets. On macOS and Windows the client talks to the
 * machine's VM over SSH, a connection per command, and sshd's `MaxStartups` drops some of a burst
 * (exit 125, `ssh: handshake failed`), so commands go through the machine's API socket instead.
 * Not when the user picked a host (`CONTAINER_HOST`, `CONTAINER_CONNECTION`, or a default
 * connection that isn't the machine's), or the socket isn't there.
 */
export function podmanHostEnv(inputs: PodmanHostInputs): Record<string, string> {
  const { platform, env } = inputs
  if (platform !== 'darwin' && platform !== 'win32') return {}
  if (env.CONTAINER_HOST || env.CONTAINER_CONNECTION) return {}
  const machine = machineHost(inputs.inspect(), platform)
  if (!machine || !inputs.exists(machine.path)) return {}
  const connections = inputs.connections()
  const chosen = Array.isArray(connections)
    ? (connections as Connection[]).find((c) => c.Default)?.Name
    : undefined
  if (chosen && chosen !== machine.name && chosen !== `${machine.name}-root`) return {}
  return { CONTAINER_HOST: machine.host }
}

const readJson = (bin: string, args: string[]): unknown => {
  try {
    const out = execFileSync(bin, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
      windowsHide: true,
    })
    return JSON.parse(out)
  } catch {
    return undefined
  }
}

let podmanEnv: Record<string, string> | undefined
/** What every command on `engine` adds to its environment; read once per process. */
export function engineEnv(engine: Engine = 'docker'): Record<string, string> {
  if (engine !== 'podman') return {}
  podmanEnv ??= podmanHostEnv({
    platform: process.platform,
    env: process.env,
    inspect: () => readJson('podman', ['machine', 'inspect']),
    connections: () => readJson('podman', ['system', 'connection', 'list', '--format', 'json']),
    exists: existsSync,
  })
  return podmanEnv
}

/** Docker's ids are `sha256:…`; Podman's are the bare hex. */
export const normalizeImageId = (id: string) => (id.includes(':') ? id : `sha256:${id}`)
