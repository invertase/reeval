// The sandbox descriptors' plain-data contract: what `docker()`, `podman()` and `fakeSandbox()` return and
// what a declaration tree from any language carries. The Zod schemas are the source of truth for
// validation, field descriptions and the JSON Schema in schema/plan/; the types in types.ts are
// the hand-written ones users hover, held to the schemas by `_SameAsSchema` below.
import { z } from 'zod'
import { UsageError } from '../errors.ts'
import type {
  DockerSandboxDescriptor,
  Duration,
  FakeSandboxDescriptor,
  InstallStep,
} from '../types.ts'
import {
  type Assert,
  closest,
  durationProblem,
  durationSchema,
  got,
  type Issue,
  nonEmpty,
  refusal,
  type Same,
} from './shared.ts'

/** Docker's memory size: bytes, or a number with `b`, `k`, `m` or `g`. */
const MEMORY = /^\d+(\.\d+)?[bkmg]?$/i

export const installStepSchema = z
  .union([
    nonEmpty(),
    z.strictObject({
      run: nonEmpty().describe('The shell command.'),
      timeout: durationSchema.optional(),
    }),
  ])
  .describe(
    'A `docker({ install })` command, baked into a cached image layer: no secrets, root, cwd `/`.',
  )

/** Every field but `kind` and `dockerfile`, shared by the descriptor and `docker()`'s options. */
const fields = {
  id: nonEmpty()
    .optional()
    .describe(
      'Cell id; defaults to `docker` (`podman`), or `docker:<image>` for other images, plus an install hash.',
    ),
  image: nonEmpty()
    .optional()
    .describe('An image that already has the harness baked in, used as is.'),
  from: z
    .string()
    .regex(/^\S+$/, 'one word')
    .optional()
    .describe(
      'A Debian or Ubuntu based toolchain image; reeval bakes Node and the harness on top, cached.',
    ),
  install: z
    .array(installStepSchema)
    .min(1)
    .optional()
    .describe(
      'Baked onto the sandbox image in one build container: in order, no secrets, no workspace.',
    ),
  maxConcurrent: z
    .number()
    .optional()
    .describe('The most Docker sandboxes at once, across the run, whatever their image.'),
  root: z
    .boolean()
    .optional()
    .describe(
      'Run the agent, setup steps and checks as root, with the capabilities `apt-get` needs, instead of the unprivileged `reeval` user. For evals that install system packages at run time.',
    ),
  capabilities: z
    .array(z.string().regex(/^(CAP_)?[A-Z_]+$/))
    .optional()
    .describe("Linux capabilities to add back, e.g. `['NET_RAW']`; every other one is dropped."),
  memory: z
    .union([z.string().regex(MEMORY), z.int().positive()])
    .optional()
    .describe("The container's memory: `'4g'` (default), `'512m'`, or bytes."),
  swap: z
    .union([z.string().regex(MEMORY), z.int().nonnegative()])
    .optional()
    .describe(
      'Swap on top of `memory`, in the same units. Default: as much as `memory`; `0` makes `memory` the hard ceiling. A host without swap has none to give.',
    ),
  cpus: z
    .number()
    .positive()
    .optional()
    .describe(
      "CPUs the container may use, fractions allowed. Default 2, capped at the Docker host's.",
    ),
  pids: z.int().positive().optional().describe('Processes and threads at once. Default 1024.'),
}

const BASES = ['image', 'from', 'dockerfile'] as const

function oneRecipe(value: Record<string, unknown>, ctx: z.RefinementCtx): void {
  const bases = BASES.filter((k) => value[k] !== undefined)
  if (bases.length > 1) ctx.addIssue({ code: 'custom', message: 'one base', params: { bases } })
  else if (value.dockerfile !== undefined && value.install !== undefined) {
    ctx.addIssue({ code: 'custom', message: 'dockerfile or install' })
  }
}

export const dockerSandboxSchema = z
  .strictObject({
    kind: z.literal('docker'),
    engine: z
      .enum(['docker', 'podman'])
      .optional()
      .describe(
        'The container CLI the sandbox runs on: `podman` for `podman()`, Docker when unset.',
      ),
    ...fields,
    dockerfile: nonEmpty()
      .optional()
      .describe(
        "A Dockerfile, absolute or relative to the directory of the file it's written in, built from its directory with `REEVAL_BASE` set to reeval's sandbox image and cached by content hash.",
      ),
  })
  .superRefine(oneRecipe)
  .describe('A local Docker container, made by `docker()`, or a Podman one, made by `podman()`.')

export const fakeSandboxSchema = z
  .strictObject({
    kind: z.literal('fake'),
    id: nonEmpty().optional().describe('Cell id; defaults to `fake`.'),
    dir: nonEmpty()
      .optional()
      .describe('Parent directory for the per-eval workspace (defaults to the OS temp dir).'),
    maxConcurrent: z
      .number()
      .optional()
      .describe('The most attempts on this sandbox kind at once, across the run.'),
  })
  .describe('A temp directory on the host instead of a container, made by `fakeSandbox()`.')

/** `docker()`'s argument: the descriptor's fields, with `dockerfile` relative or a `file:` URL. */
export const dockerOptionsSchema = z
  .strictObject({
    ...fields,
    dockerfile: z
      .union([nonEmpty(), z.instanceof(URL)])
      .optional()
      .describe('Relative to the file that calls `docker()`, or an absolute path or `URL`.'),
  })
  .superRefine(oneRecipe)

/** `docker()`'s (and `podman()`'s) argument, as users write it. */
export type DockerOptions = Omit<DockerSandboxDescriptor, 'kind' | 'engine' | 'dockerfile'> & {
  /** Relative to the file that calls `docker()`, or an absolute path or `URL`. */
  dockerfile?: string | URL
}

export type _SameAsSchema = [
  Assert<Same<z.infer<typeof dockerSandboxSchema>, DockerSandboxDescriptor>>,
  Assert<Same<keyof z.infer<typeof dockerSandboxSchema>, keyof DockerSandboxDescriptor>>,
  Assert<Same<z.infer<typeof fakeSandboxSchema>, FakeSandboxDescriptor>>,
  Assert<Same<keyof z.infer<typeof fakeSandboxSchema>, keyof FakeSandboxDescriptor>>,
  Assert<Same<z.input<typeof dockerOptionsSchema>, DockerOptions>>,
  Assert<Same<z.infer<typeof installStepSchema>, InstallStep>>,
  Assert<Same<z.infer<typeof durationSchema>, Duration>>,
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
  memorySwap: 'swap',
  memswap: 'swap',
  cpu: 'cpus',
  pidsLimit: 'pids',
}

/** The sentence for a field whose value the schema refused, given the value. */
const FIELD: Record<string, (value: unknown) => string> = {
  id: (v) => `docker({ id }) must be a non-empty string (got ${got(v)})`,
  image: (v) => `docker({ image }) must be a non-empty string (got ${got(v)})`,
  from: (v) =>
    `docker({ from }) takes an image reference with no spaces or line breaks, e.g. from: 'python:3.12-slim' (got ${got(v)})`,
  root: (v) => `docker({ root }) is true or false (got ${got(v)})`,
  capabilities: (v) =>
    `docker({ capabilities }) takes Linux capability names, e.g. capabilities: ['NET_RAW'] (got ${got(v)})`,
  memory: (v) => `docker({ memory }) takes a size such as '4g' or '512m', or bytes (got ${got(v)})`,
  swap: (v) =>
    `docker({ swap }) takes a size such as '2g' or '512m', bytes, or 0 for none (got ${got(v)})`,
  cpus: (v) =>
    `docker({ cpus }) takes a number of CPUs above zero, e.g. 1.5 (got ${typeof v === 'number' ? String(v) : got(v)})`,
  pids: (v) => `docker({ pids }) takes a whole number of processes above zero (got ${got(v)})`,
  maxConcurrent: (v) => `docker({ maxConcurrent }) takes a number (got ${got(v)})`,
  kind: (v) => `a Docker sandbox's kind is "docker" (got ${got(v)})`,
  engine: (v) => `a Docker sandbox's engine is "docker" or "podman" (got ${got(v)})`,
  dockerfile: (v) =>
    `docker({ dockerfile }) takes a path, e.g. dockerfile: './Dockerfile' (got ${got(v)})`,
  install: (v) =>
    `docker({ install }) takes a non-empty list of shell commands, e.g. install: ['apt-get update && apt-get install -y jq'] (got ${got(v)})`,
}

/** Which refusal to report when there are several: the order `docker()` has always checked in. */
const ORDER = [
  'kind',
  'engine',
  'id',
  'image',
  'from',
  'root',
  'capabilities',
  'memory',
  'swap',
  'cpus',
  'pids',
]

// Zod reports a bad timeout inside the step's union, so the step itself says which sentence fits.
function installMessage(step: unknown): string {
  const { run, timeout } = (typeof step === 'object' && step !== null ? step : {}) as {
    run?: unknown
    timeout?: unknown
  }
  const keys = typeof step === 'object' && step !== null ? Object.keys(step) : []
  if (typeof run === 'string' && run.trim()) {
    const extra = keys.find((k) => k !== 'run' && k !== 'timeout')
    if (extra) {
      const hint = closest(extra, ['timeout']) ? ' Did you mean "timeout"?' : ''
      return `docker({ install }) command "${run}" has an unknown key "${extra}"; a command is a string or { run, timeout? }.${hint}`
    }
    const problem = timeout === undefined ? undefined : durationProblem(timeout)
    if (problem) return `docker({ install }) command "${run}": ${problem}`
  }
  return `docker({ install }) commands are strings or { run, timeout? } objects (got ${got(step)})`
}

/** reeval's sentence for the first thing Zod refused, in the words `docker()` has always used. */
function explainDocker(issue: Issue, value: unknown): string {
  const options = value as Record<string, unknown>
  if (issue.code === 'unrecognized_keys' && issue.path.length === 0) {
    const key = issue.keys[0] as string
    if (key === 'environment' || key === 'env') {
      return `Unknown docker() option "${key}". The sandbox is what's baked into the image; variables and secrets belong in defineEnvironment({ env }).`
    }
    const hint = DOCKER_HINTS[key] ? ` Did you mean "${DOCKER_HINTS[key]}"?` : ''
    return `Unknown docker() option "${key}".${hint}`
  }
  if (issue.code === 'custom') {
    const { bases } = (issue.params ?? {}) as { bases?: string[] }
    return bases
      ? `docker() takes one base image, but got ${bases.join(' and ')}. Use image (has the harness), from (a toolchain image reeval bakes the harness onto) or dockerfile.`
      : "docker() takes dockerfile or install, not both: put the install commands in the Dockerfile as RUN lines, so there's one recipe for the image."
  }
  const key = String(issue.path[0])
  if (key === 'install' && issue.path.length > 1) {
    return installMessage((options.install as unknown[])[issue.path[1] as number])
  }
  return (FIELD[key] ?? ((v) => `docker({ ${key} }) is invalid (got ${got(v)})`))(options[key])
}

function explainFake(issue: Issue, value: unknown): string {
  if (issue.code === 'unrecognized_keys' && issue.path.length === 0) {
    const key = issue.keys[0] as string
    const near = closest(key, Object.keys(fakeSandboxSchema.shape))
    return `Unknown fakeSandbox() option "${key}".${near ? ` Did you mean "${near}"?` : ''}`
  }
  const key = String(issue.path[0])
  const v = (value as Record<string, unknown>)[key]
  return key === 'maxConcurrent'
    ? `fakeSandbox({ maxConcurrent }) takes a number (got ${got(v)})`
    : `fakeSandbox({ ${key} }) must be a non-empty string (got ${got(v)})`
}

/** A refusal in the words of the function that makes the sandbox: `podman({ memory })`. */
const named = (problem: string | undefined, engine: 'docker' | 'podman' | undefined) =>
  problem && engine === 'podman'
    ? problem.replace(/\bdocker\(/g, 'podman(').replace(/\bA Docker sandbox/g, 'A Podman sandbox')
    : problem

/** `docker()`'s (or `podman()`'s) options, checked; throws reeval's sentence for the first problem. */
export function checkDockerOptions(options: DockerOptions, engine?: 'docker' | 'podman'): void {
  const problem = named(
    refusal(dockerOptionsSchema, options, explainDocker, { order: ORDER }),
    engine,
  )
  if (problem) throw new UsageError(problem)
}

/**
 * What's wrong with a sandbox descriptor of a known kind from any source (a declaration tree, a
 * config), or undefined. `maxConcurrent` is left to the check that names where it was set.
 */
export function sandboxProblem(value: DockerSandboxDescriptor | FakeSandboxDescriptor) {
  return value.kind === 'docker'
    ? named(
        refusal(dockerSandboxSchema, value, explainDocker, {
          order: ORDER,
          skip: ['maxConcurrent'],
        }),
        value.engine,
      )
    : refusal(fakeSandboxSchema, value, explainFake, { skip: ['maxConcurrent'] })
}
