import { createHash } from 'node:crypto'
import { existsSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DOCKER_SECCOMP_PROFILE } from './seccomp-profile.ts'

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

let seccompFile: string | undefined
/**
 * Docker's default seccomp profile as a file Podman can read, written once per content under the
 * temp directory (a compiled reeval has no real file of its own to point at).
 */
export function dockerSeccompFile(): string {
  if (seccompFile && existsSync(seccompFile)) return seccompFile
  const json = JSON.stringify(DOCKER_SECCOMP_PROFILE)
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

/** Docker's ids are `sha256:…`; Podman's are the bare hex. */
export const normalizeImageId = (id: string) => (id.includes(':') ? id : `sha256:${id}`)
