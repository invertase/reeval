// `reeval/sandbox`: sandbox descriptors. The implementations load lazily in workers.
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkDockerOptions, type DockerOptions } from './contract/docker.ts'
import { callerDir } from './environment.ts'
import { UsageError } from './errors.ts'
import type { DockerSandboxDescriptor, FakeSandboxDescriptor } from './types.ts'

export type { DockerOptions } from './contract/docker.ts'

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
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new UsageError(`docker() takes an options object (got ${JSON.stringify(options)})`)
  }
  const { dockerfile, ...rest } = checkDockerOptions(options)
  const descriptor: DockerSandboxDescriptor = { kind: 'docker', ...rest }
  if (dockerfile !== undefined) {
    const path = dockerfile instanceof URL ? fileURLToPath(dockerfile) : dockerfile
    const full = isAbsolute(path) ? path : resolve(callerDir() ?? process.cwd(), path)
    if (!existsSync(full) || !statSync(full).isFile()) {
      throw new UsageError(
        `docker({ dockerfile: ${JSON.stringify(path)} }): ${full} doesn't exist. Paths are relative to the file that calls docker().`,
      )
    }
    descriptor.dockerfile = full
  }
  return descriptor
}

/**
 * A temp directory on the host with no isolation. For tests and the fake harness only. `dir` may
 * be a `file:` URL, such as `new URL('./sandboxes', import.meta.url)`.
 */
export const fakeSandbox = ({
  dir,
  ...options
}: Omit<FakeSandboxDescriptor, 'kind' | 'dir'> & { dir?: string | URL } = {}) =>
  ({
    kind: 'fake',
    ...options,
    ...(dir !== undefined && { dir: dir instanceof URL ? fileURLToPath(dir) : dir }),
  }) satisfies FakeSandboxDescriptor

export type { DockerSandboxDescriptor, FakeSandboxDescriptor, SandboxDescriptor } from './types.ts'
