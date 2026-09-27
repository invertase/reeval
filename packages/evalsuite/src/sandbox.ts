// `evalsuite/sandbox`: sandbox descriptors. The implementations load lazily in workers.
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDuration } from './duration.ts'
import { callerDir } from './environment.ts'
import { UsageError } from './errors.ts'
import type {
  DockerSandboxDescriptor,
  Duration,
  FakeSandboxDescriptor,
  InstallStep,
} from './types.ts'

export type DockerOptions = Omit<DockerSandboxDescriptor, 'kind' | 'dockerfile'> & {
  /** Relative to the file that calls `docker()`, or an absolute path or `URL`. */
  dockerfile?: string | URL
}

const DOCKER_KEYS = [
  'id',
  'image',
  'from',
  'dockerfile',
  'install',
  'maxConcurrent',
  'root',
  'capabilities',
  'memory',
  'cpus',
  'pids',
]
const DOCKER_HINTS: Record<string, string> = {
  steps: 'install',
  run: 'install',
  setup: 'install',
  image_steps: 'install',
  file: 'dockerfile',
  build: 'dockerfile',
  base: 'from',
  user: 'root',
  privileged: 'root',
  capAdd: 'capabilities',
  caps: 'capabilities',
  mem: 'memory',
  memoryLimit: 'memory',
  cpu: 'cpus',
  pidsLimit: 'pids',
}

/** Docker's memory size: bytes, or a number with `b`, `k`, `m` or `g`. */
const MEMORY = /^\d+(\.\d+)?[bkmg]?$/i

function checkConfinement(options: DockerOptions): void {
  const { root, capabilities, memory, cpus, pids } = options
  if (root !== undefined && typeof root !== 'boolean') {
    throw new UsageError(`docker({ root }) is true or false (got ${JSON.stringify(root)})`)
  }
  if (
    capabilities !== undefined &&
    (!Array.isArray(capabilities) ||
      !capabilities.every((c) => typeof c === 'string' && /^(CAP_)?[A-Z_]+$/.test(c)))
  ) {
    throw new UsageError(
      `docker({ capabilities }) takes Linux capability names, e.g. capabilities: ['NET_RAW'] (got ${JSON.stringify(capabilities)})`,
    )
  }
  if (
    memory !== undefined &&
    !(typeof memory === 'number' ? Number.isInteger(memory) && memory > 0 : MEMORY.test(memory))
  ) {
    throw new UsageError(
      `docker({ memory }) takes a size such as '4g' or '512m', or bytes (got ${JSON.stringify(memory)})`,
    )
  }
  if (cpus !== undefined && !(typeof cpus === 'number' && cpus > 0 && Number.isFinite(cpus))) {
    throw new UsageError(
      `docker({ cpus }) takes a number of CPUs above zero, e.g. 1.5 (got ${JSON.stringify(cpus)})`,
    )
  }
  if (pids !== undefined && !(Number.isInteger(pids) && (pids as number) > 0)) {
    throw new UsageError(
      `docker({ pids }) takes a whole number of processes above zero (got ${JSON.stringify(pids)})`,
    )
  }
}

function checkInstall(install: unknown): InstallStep[] {
  if (!Array.isArray(install) || install.length === 0) {
    throw new UsageError(
      `docker({ install }) takes a non-empty list of shell commands, e.g. install: ['apt-get update && apt-get install -y jq'] (got ${JSON.stringify(install)})`,
    )
  }
  for (const step of install) {
    const run = typeof step === 'string' ? step : (step as { run?: unknown })?.run
    const timeout = typeof step === 'string' ? undefined : (step as { timeout?: unknown }).timeout
    if (typeof run !== 'string' || !run.trim()) {
      throw new UsageError(
        `docker({ install }) commands are strings or { run, timeout? } objects (got ${JSON.stringify(step)})`,
      )
    }
    if (timeout === undefined) continue
    try {
      parseDuration(timeout as Duration)
    } catch (error) {
      throw new UsageError(`docker({ install }) command "${run}": ${(error as Error).message}`)
    }
  }
  return structuredClone(install)
}

/**
 * One local Docker container per attempt. By default it's the image `es image build` makes. One
 * base at most:
 *
 * - `image`: another image that already has the harness baked in, used as is.
 * - `from`: a Debian or Ubuntu based toolchain image (e.g. `python:3.12-slim`); ES bakes Node and
 *   the harness on top on first use.
 * - `dockerfile`: your Dockerfile, built with `docker build` from its directory. Start it
 *   `ARG ES_BASE` / `FROM ${ES_BASE}` to layer on ES's sandbox image; from any other Debian or
 *   Ubuntu base, ES bakes Node and the harness on top, as for `from`.
 *
 * `install` bakes shell commands onto the base in one cached layer (not with `dockerfile`: put
 * them in it). They run as root from `/`, in order, and never see secrets or the workspace; what
 * needs either belongs in the environment's `setup`.
 *
 * At run time the agent, setup steps and checks run as the unprivileged `es` user with every
 * capability dropped, `no-new-privileges`, and `memory`, `cpus` and `pids` limits. `root: true`
 * opts an eval into root; `capabilities` adds specific ones back.
 */
export function docker(options: DockerOptions = {}): DockerSandboxDescriptor {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new UsageError(`docker() takes an options object (got ${JSON.stringify(options)})`)
  }
  for (const key of Object.keys(options)) {
    if (DOCKER_KEYS.includes(key)) continue
    if (key === 'environment' || key === 'env') {
      throw new UsageError(
        `Unknown docker() option "${key}". The sandbox is what's baked into the image; variables and secrets belong in defineEnvironment({ env }).`,
      )
    }
    const hint = DOCKER_HINTS[key] ? ` Did you mean "${DOCKER_HINTS[key]}"?` : ''
    throw new UsageError(`Unknown docker() option "${key}".${hint}`)
  }
  const bases = (['image', 'from', 'dockerfile'] as const).filter((k) => options[k] !== undefined)
  if (bases.length > 1) {
    throw new UsageError(
      `docker() takes one base image, but got ${bases.join(' and ')}. Use image (has the harness), from (a toolchain image ES bakes the harness onto) or dockerfile.`,
    )
  }
  for (const key of ['id', 'image', 'from'] as const) {
    const value = options[key]
    if (value !== undefined && (typeof value !== 'string' || !value.trim())) {
      throw new UsageError(
        `docker({ ${key} }) must be a non-empty string (got ${JSON.stringify(value)})`,
      )
    }
  }
  checkConfinement(options)
  const { dockerfile, install, ...rest } = options
  const descriptor: DockerSandboxDescriptor = { kind: 'docker', ...rest }
  if (rest.capabilities) descriptor.capabilities = [...rest.capabilities]
  if (dockerfile !== undefined) {
    if (install !== undefined) {
      throw new UsageError(
        "docker() takes dockerfile or install, not both: put the install commands in the Dockerfile as RUN lines, so there's one recipe for the image.",
      )
    }
    if (!(dockerfile instanceof URL) && (typeof dockerfile !== 'string' || !dockerfile.trim())) {
      throw new UsageError(
        `docker({ dockerfile }) takes a path, e.g. dockerfile: './Dockerfile' (got ${JSON.stringify(dockerfile)})`,
      )
    }
    const path = dockerfile instanceof URL ? fileURLToPath(dockerfile) : dockerfile
    const full = isAbsolute(path) ? path : resolve(callerDir() ?? process.cwd(), path)
    if (!existsSync(full) || !statSync(full).isFile()) {
      throw new UsageError(
        `docker({ dockerfile: ${JSON.stringify(path)} }): ${full} doesn't exist. Paths are relative to the file that calls docker().`,
      )
    }
    descriptor.dockerfile = full
  }
  if (install !== undefined) descriptor.install = checkInstall(install)
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
