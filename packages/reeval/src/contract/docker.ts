// The Docker sandbox's plain-data contract: what `docker()` returns and what a declaration tree
// from any language carries. The Zod schema is the source of truth for validation, field
// descriptions and the JSON Schema in schema/plan/; `DockerSandboxDescriptor` in types.ts is the
// hand-written type users hover, held to the schema by `_SameAsSchema` below.
import { z } from 'zod'
import { parseDuration } from '../duration.ts'
import { UsageError } from '../errors.ts'
import type { DockerSandboxDescriptor, Duration, InstallStep } from '../types.ts'

/** Docker's memory size: bytes, or a number with `b`, `k`, `m` or `g`. */
const MEMORY = /^\d+(\.\d+)?[bkmg]?$/i
// More than zero, so at least one non-zero digit.
const DURATION = /^(?=.*[1-9])\d+(\.\d+)?(ms|s|m|h)$/
const nonEmpty = () => z.string().regex(/\S/)

export const durationSchema = z
  .union([
    z.number().positive(),
    // The template literal gives `Duration`'s type; its own JSON Schema pattern allows `-5s`.
    z
      .templateLiteral([z.number(), z.enum(['ms', 's', 'm', 'h'])])
      .check(z.regex(DURATION))
      .meta({ pattern: DURATION.source }),
  ])
  .describe('More than zero: `90s`, `15m`, `1h`, or a number of milliseconds.')

export const installStepSchema = z
  .union([nonEmpty(), z.strictObject({ run: nonEmpty(), timeout: durationSchema.optional() })])
  .describe(
    'A `docker({ install })` command, baked into a cached image layer: no secrets, root, cwd `/`.',
  )

/** Every field but `kind` and `dockerfile`, shared by the descriptor and `docker()`'s options. */
const fields = {
  id: nonEmpty()
    .optional()
    .describe(
      'Cell id; defaults to `docker`, or `docker:<image>` for other images, plus an install hash.',
    ),
  image: nonEmpty()
    .optional()
    .describe('An image that already has the harness baked in, used as is.'),
  from: nonEmpty()
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
  // `options.ts` checks it for every sandbox and harness, with the option's place in its message.
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
    .union([z.int().positive(), z.string().regex(MEMORY)])
    .optional()
    .describe("The container's memory: `'4g'` (default), `'512m'`, or bytes."),
  swap: z
    .union([z.int().nonnegative(), z.string().regex(MEMORY)])
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
    ctx.addIssue({ code: 'custom', message: 'dockerfile or install', params: { recipe: true } })
  }
}

export const dockerSandboxSchema = z
  .strictObject({
    kind: z.literal('docker'),
    ...fields,
    dockerfile: nonEmpty()
      .optional()
      .describe(
        "An absolute path to a Dockerfile (`docker()` resolves it against the calling file), built from its directory with `REEVAL_BASE` set to reeval's sandbox image and cached by content hash.",
      ),
  })
  .superRefine(oneRecipe)
  .describe('One local Docker container per attempt.')

/** The schemas that own a `$def` in schema/plan/, by its name there (scripts/schema/zod.ts). */
export const CONTRACT_SCHEMAS = {
  DockerSandboxDescriptor: dockerSandboxSchema,
  InstallStep: installStepSchema,
}

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

/** `docker()`'s argument, as users write it. */
export type DockerOptions = Omit<DockerSandboxDescriptor, 'kind' | 'dockerfile'> & {
  /** Relative to the file that calls `docker()`, or an absolute path or `URL`. */
  dockerfile?: string | URL
}

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Assert<T extends true> = T
export type _SameAsSchema = [
  Assert<Same<z.infer<typeof dockerSandboxSchema>, DockerSandboxDescriptor>>,
  Assert<Same<z.input<typeof dockerOptionsSchema>, DockerOptions>>,
  Assert<Same<z.infer<typeof installStepSchema>, InstallStep>>,
  Assert<Same<z.infer<typeof durationSchema>, Duration>>,
  Assert<Same<keyof z.infer<typeof dockerSandboxSchema>, keyof DockerSandboxDescriptor>>,
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

const got = (value: unknown) => JSON.stringify(value)

/** The sentence for a field whose value the schema refused, given the value. */
const FIELD: Record<string, (value: unknown) => string> = {
  id: (v) => `docker({ id }) must be a non-empty string (got ${got(v)})`,
  image: (v) => `docker({ image }) must be a non-empty string (got ${got(v)})`,
  from: (v) => `docker({ from }) must be a non-empty string (got ${got(v)})`,
  root: (v) => `docker({ root }) is true or false (got ${got(v)})`,
  capabilities: (v) =>
    `docker({ capabilities }) takes Linux capability names, e.g. capabilities: ['NET_RAW'] (got ${got(v)})`,
  memory: (v) => `docker({ memory }) takes a size such as '4g' or '512m', or bytes (got ${got(v)})`,
  swap: (v) =>
    `docker({ swap }) takes a size such as '2g' or '512m', bytes, or 0 for none (got ${got(v)})`,
  cpus: (v) => `docker({ cpus }) takes a number of CPUs above zero, e.g. 1.5 (got ${got(v)})`,
  pids: (v) => `docker({ pids }) takes a whole number of processes above zero (got ${got(v)})`,
  maxConcurrent: (v) => `docker({ maxConcurrent }) takes a number (got ${got(v)})`,
  kind: (v) => `a Docker sandbox's kind is "docker" (got ${got(v)})`,
  dockerfile: (v) =>
    `docker({ dockerfile }) takes a path, e.g. dockerfile: './Dockerfile' (got ${got(v)})`,
  install: (v) =>
    `docker({ install }) takes a non-empty list of shell commands, e.g. install: ['apt-get update && apt-get install -y jq'] (got ${got(v)})`,
}

/** Which refusal to report when there are several: the order `docker()` has always checked in. */
const ORDER = ['id', 'image', 'from', 'root', 'capabilities', 'memory', 'swap', 'cpus', 'pids']
const rank = (issue: z.core.$ZodIssue) => {
  if (issue.code === 'unrecognized_keys') return -1
  const at = ORDER.indexOf(String(issue.path[0]))
  return at === -1 ? ORDER.length : at
}

// Zod reports a bad timeout inside the step's union, so the step itself says which sentence fits.
function installMessage(issue: z.core.$ZodIssue, install: unknown[]): string {
  const step = install[issue.path[1] as number] as { run?: unknown; timeout?: unknown }
  const run = typeof step === 'object' && step !== null ? step.run : undefined
  if (typeof run === 'string' && run.trim() && step.timeout !== undefined) {
    try {
      parseDuration(step.timeout as Duration)
    } catch (error) {
      return `docker({ install }) command "${run}": ${(error as Error).message}`
    }
  }
  return `docker({ install }) commands are strings or { run, timeout? } objects (got ${got(step)})`
}

/** reeval's one sentence for the first thing Zod refused, in the words `docker()` has always used. */
export function dockerMessage(issues: z.core.$ZodIssue[], value: Record<string, unknown>): string {
  const issue = [...issues].sort((a, b) => rank(a) - rank(b))[0] as z.core.$ZodIssue
  if (issue.code === 'unrecognized_keys') {
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
    return installMessage(issue, value.install as unknown[])
  }
  return (FIELD[key] ?? ((v) => `docker({ ${key} }) is invalid (got ${got(v)})`))(value[key])
}

/** `docker()`'s options, checked; throws reeval's sentence for the first problem. */
export function checkDockerOptions(options: unknown): DockerOptions {
  const result = dockerOptionsSchema.safeParse(options)
  if (!result.success) {
    throw new UsageError(dockerMessage(result.error.issues, options as Record<string, unknown>))
  }
  return result.data
}

/** What's wrong with a Docker sandbox descriptor from any source (a declaration tree, a config). */
export function dockerSandboxProblem(value: unknown): string | null {
  const result = dockerSandboxSchema.safeParse(value)
  return result.success
    ? null
    : dockerMessage(result.error.issues, value as Record<string, unknown>)
}
