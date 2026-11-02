// `reeval/sandbox`: sandbox descriptors. The implementations load lazily in workers.
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkDockerOptions, type DockerOptions } from './contract/docker.ts'
import { checkTartOptions, type TartOptions } from './contract/tart.ts'
import { callerDir, toPath } from './environment.ts'
import { UsageError } from './errors.ts'
import type {
  DockerSandboxDescriptor,
  FakeSandboxDescriptor,
  TartSandboxDescriptor,
} from './types.ts'

export type { DockerOptions } from './contract/docker.ts'
export type { TartOptions } from './contract/tart.ts'

/**
 * One local Docker container per attempt. By default it's the image `reeval image build` makes. One
 * base at most:
 *
 * - `image`: another image that already has the harness baked in, used as is.
 * - `from`: a Debian or Ubuntu based toolchain image (e.g. `python:3.12-slim`); reeval bakes Node and
 *   the harness on top on first use.
 * - `dockerfile`: your Dockerfile, built with `docker build` from its directory. Start it
 *   `ARG REEVAL_BASE` / `FROM ${REEVAL_BASE}` to layer on reeval's sandbox image; from any other Debian or
 *   Ubuntu base, reeval bakes Node and the harness on top, as for `from`.
 *
 * `install` bakes shell commands onto the base in one cached layer (not with `dockerfile`: put
 * them in it). They run as root from `/`, in order, and never see secrets or the workspace; what
 * needs either belongs in the environment's `setup`.
 *
 * At run time the agent, setup steps and checks run as the unprivileged `reeval` user with every
 * capability dropped, `no-new-privileges`, and `memory`, `cpus` and `pids` limits, with `swap`
 * (as much as `memory` by default) on top of `memory`. `root: true` opts an eval into root;
 * `capabilities` adds specific ones back.
 */
export function docker(options: DockerOptions = {}): DockerSandboxDescriptor {
  return containerSandbox(options, 'docker')
}

/**
 * {@link docker}, on Podman: the same options, images, egress gateway and records, with containers
 * run by the `podman` CLI (rootless works). Every container is on Podman's bridge network with
 * Docker's default seccomp profile, so it's confined as on Docker, and a restricted egress policy
 * leaves it no route out. `from` and Dockerfile `FROM` names Podman can't resolve need their
 * registry: `docker.io/library/python:3.12-slim`.
 */
export function podman(options: DockerOptions = {}): DockerSandboxDescriptor {
  return containerSandbox(options, 'podman')
}

function containerSandbox(
  options: DockerOptions,
  engine: 'docker' | 'podman',
): DockerSandboxDescriptor {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new UsageError(`${engine}() takes an options object (got ${JSON.stringify(options)})`)
  }
  checkDockerOptions(options, engine)
  const { dockerfile, ...rest } = options
  const descriptor: DockerSandboxDescriptor = {
    kind: 'docker',
    ...(engine === 'podman' ? { engine } : {}),
    ...structuredClone(rest),
  }
  if (dockerfile !== undefined) {
    const path = dockerfile instanceof URL ? fileURLToPath(dockerfile) : dockerfile
    const full = isAbsolute(path) ? path : resolve(callerDir() ?? process.cwd(), path)
    if (!existsSync(full) || !statSync(full).isFile()) {
      throw new UsageError(
        `${engine}({ dockerfile: ${JSON.stringify(path)} }): ${full} doesn't exist. Paths are relative to the file that calls ${engine}().`,
      )
    }
    descriptor.dockerfile = full
  }
  return descriptor
}

/**
 * A macOS VM on this Apple Silicon Mac, run by [Tart](https://tart.run). Each attempt clones
 * `image` (an OCI image, which `reeval image build` pulls, or a local VM), boots it headless,
 * works in it over `tart exec`, and deletes it. A run refuses an image Tart doesn't have. `ssh` reaches an image without the Tart Guest Agent instead.
 * At most two run at once (`maxConcurrent`), as macOS allows.
 *
 * The VM keeps Tart's network, so it runs under `egress: 'allow-all'` only: what ignores the
 * egress gateway's proxy goes out directly, unrecorded. Brokered secrets still stay on the host.
 */
export function tart(options: TartOptions): TartSandboxDescriptor {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new UsageError(`tart() takes an options object (got ${JSON.stringify(options)})`)
  }
  checkTartOptions(options)
  const { ssh, ...rest } = options
  const descriptor: TartSandboxDescriptor = { kind: 'tart', ...structuredClone(rest) }
  if (ssh) {
    const key = toPath(ssh.key, callerDir() ?? process.cwd())
    if (!existsSync(key) || !statSync(key).isFile()) {
      throw new UsageError(
        `tart({ ssh: { key } }): ${key} doesn't exist. Paths are relative to the file that calls tart().`,
      )
    }
    descriptor.ssh = { ...(ssh.user !== undefined && { user: ssh.user }), key }
  }
  return descriptor
}

/**
 * A temp directory on the host with no isolation. For tests and the fake harness only. A relative
 * `dir` resolves against the file that calls `fakeSandbox()`; it may also be absolute or a `file:`
 * URL, such as `new URL('./sandboxes', import.meta.url)`.
 */
export const fakeSandbox = ({
  dir,
  ...options
}: Omit<FakeSandboxDescriptor, 'kind' | 'dir'> & { dir?: string | URL } = {}) =>
  ({
    kind: 'fake',
    ...options,
    ...(dir !== undefined && { dir: toPath(dir, callerDir() ?? process.cwd()) }),
  }) satisfies FakeSandboxDescriptor

export type {
  DockerSandboxDescriptor,
  FakeSandboxDescriptor,
  SandboxDescriptor,
  TartSandboxDescriptor,
} from './types.ts'
