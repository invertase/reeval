// The Daytona sandbox's plain-data contract: what `daytona()` returns and what a declaration tree
// from any language carries. The types in types.ts are the ones users hover, held to these schemas
// by `_SameAsSchema` below.
import { z } from 'zod'
import { UsageError } from '../errors.ts'
import type { DaytonaApiKey, DaytonaSandboxDescriptor, DaytonaSize } from '../types.ts'
import { BOAT_ATTEMPTS_PER_MACHINE_MAX, BOAT_PREFIX, BOAT_PREFIX_MAX } from './boat.ts'
import { VAR } from './plain.ts'
import { type Assert, closest, got, type Issue, nonEmpty, refusal, type Same } from './shared.ts'

/** reeval adds `-<run>-<attempt>` (16 characters) to a sandbox's prefix, as for Boat. */
export const DAYTONA_PREFIX = BOAT_PREFIX
export const DAYTONA_PREFIX_MAX = BOAT_PREFIX_MAX
export const DAYTONA_SIZES = ['small', 'medium', 'large'] as const
/** Slot `n` listens on the gateway's port plus `n`, as on Boat. */
export const DAYTONA_ATTEMPTS_PER_MACHINE_MAX = BOAT_ATTEMPTS_PER_MACHINE_MAX

const apiKeySchema = z.strictObject({ kind: z.literal('secret'), from: z.string().regex(VAR) })
const prefixSchema = z.string().max(DAYTONA_PREFIX_MAX).regex(DAYTONA_PREFIX)
const sizeSchema = z.enum(DAYTONA_SIZES)
const attemptsSchema = z.number().int().min(1).max(DAYTONA_ATTEMPTS_PER_MACHINE_MAX)

export const daytonaSandboxSchema = z.strictObject({
  kind: z.literal('daytona'),
  id: nonEmpty().optional(),
  apiKey: apiKeySchema,
  prefix: prefixSchema,
  size: sizeSchema.optional(),
  maxConcurrent: z.number().optional(),
  reuse: z.boolean().optional(),
  attemptsPerMachine: attemptsSchema.optional(),
})

/** `createDaytona()`'s argument: the account and naming every sandbox of the factory shares. */
export type CreateDaytonaOptions = {
  /** The host variable with the API key, as `secret.fromEnv('DAYTONA_API_KEY')`. Default `DAYTONA_API_KEY`. */
  apiKey?: DaytonaApiKey
  /** The start of every sandbox name. Default `reeval`. */
  prefix?: string
}

/** `daytona()`'s argument. */
export type DaytonaOptions = Omit<DaytonaSandboxDescriptor, 'kind' | 'apiKey' | 'prefix'>

export const createDaytonaOptionsSchema = z.strictObject({
  apiKey: apiKeySchema.optional(),
  prefix: prefixSchema.optional(),
})

export const daytonaOptionsSchema = z.strictObject({
  id: nonEmpty().optional(),
  size: sizeSchema.optional(),
  maxConcurrent: z.number().optional(),
  reuse: z.boolean().optional(),
  attemptsPerMachine: attemptsSchema.optional(),
})

export type _SameAsSchema = [
  Assert<Same<z.infer<typeof daytonaSandboxSchema>, DaytonaSandboxDescriptor>>,
  Assert<Same<keyof z.infer<typeof daytonaSandboxSchema>, keyof DaytonaSandboxDescriptor>>,
  Assert<Same<z.infer<typeof apiKeySchema>, DaytonaApiKey>>,
  Assert<Same<z.infer<typeof sizeSchema>, DaytonaSize>>,
  Assert<Same<z.input<typeof createDaytonaOptionsSchema>, CreateDaytonaOptions>>,
  Assert<Same<z.input<typeof daytonaOptionsSchema>, DaytonaOptions>>,
]

const SIZES =
  "pick a size with size: 'small' (1 vCPU, 1 GiB), 'medium' (2 vCPUs, 4 GiB) or 'large' (4 vCPUs, 8 GiB)"

/** Docker's options, which a Daytona sandbox doesn't have (yet), and what to do instead. */
const NOT_ON_DAYTONA: Record<string, string> = {
  image:
    "Daytona sandboxes start from Daytona's default snapshot, and the harness installs as the attempt starts",
  from: "Daytona sandboxes start from Daytona's default snapshot; run your toolchain's installs in the environment's setup",
  dockerfile:
    "Daytona sandboxes start from Daytona's default snapshot; run your toolchain's installs in the environment's setup",
  install: "run them in the environment's setup, which runs in the sandbox before the agent starts",
  root: 'the agent, setup steps and checks run as the unprivileged reeval user, and a Daytona sandbox has no root mode yet',
  capabilities: 'a Daytona sandbox has no container capabilities to add',
  memory: SIZES,
  cpus: SIZES,
  swap: SIZES,
  pids: 'a Daytona sandbox has no process limit to set',
  engine: 'daytona() runs on Daytona, not a local container engine',
  type: SIZES,
}

const ORDER = ['id', 'size', 'maxConcurrent', 'reuse', 'attemptsPerMachine']

function explain(fn: string) {
  return (issue: Issue, value: unknown): string => {
    const options = (value ?? {}) as Record<string, unknown>
    if (issue.code === 'unrecognized_keys' && issue.path.length === 0) {
      const key = issue.keys[0] as string
      if (NOT_ON_DAYTONA[key]) return `${fn}() doesn't take ${key}: ${NOT_ON_DAYTONA[key]}.`
      const near = closest(key, fn === 'createDaytona' ? ['apiKey', 'prefix'] : ORDER)
      return `Unknown ${fn}() option "${key}".${near ? ` Did you mean "${near}"?` : ''}`
    }
    const key = String(issue.path[0])
    const v = options[key]
    switch (key) {
      case 'apiKey':
        return typeof v === 'string'
          ? `${fn}({ apiKey }) takes the host variable that holds the key, never the key: apiKey: secret.fromEnv('DAYTONA_API_KEY'), with secret from a defineConfig callback. The key stays on the host.`
          : `${fn}({ apiKey }) takes secret.fromEnv('<HOST_VARIABLE>') (got ${got(v)})`
      case 'prefix':
        return `${fn}({ prefix }) takes lowercase letters, digits and dashes, starting and ending with a letter or digit, at most ${DAYTONA_PREFIX_MAX} characters, e.g. prefix: 'acme-evals' (got ${got(v)})`
      case 'size':
        return `${fn}({ size }) is one of ${DAYTONA_SIZES.map((t) => `'${t}'`).join(', ')} (got ${got(v)})`
      case 'id':
        return `${fn}({ id }) must be a non-empty string (got ${got(v)})`
      case 'maxConcurrent':
        return `${fn}({ maxConcurrent }) takes a number (got ${got(v)})`
      case 'reuse':
        return `${fn}({ reuse }) is true or false (got ${got(v)})`
      case 'attemptsPerMachine':
        return `${fn}({ attemptsPerMachine }) is a whole number from 1 to ${DAYTONA_ATTEMPTS_PER_MACHINE_MAX} (got ${got(v)})`
      case 'kind':
        return `a Daytona sandbox's kind is "daytona" (got ${got(v)})`
      default:
        return `${fn}({ ${key} }) is invalid (got ${got(v)})`
    }
  }
}

/** `createDaytona()`'s options, checked; throws reeval's sentence for the first problem. */
export function checkCreateDaytonaOptions(options: unknown): void {
  const problem = refusal(createDaytonaOptionsSchema, options, explain('createDaytona'), {
    order: ['apiKey', 'prefix'],
  })
  if (problem) throw new UsageError(problem)
}

/** `daytona()`'s options, checked; throws reeval's sentence for the first problem. */
export function checkDaytonaOptions(options: unknown): void {
  const problem = refusal(daytonaOptionsSchema, options, explain('daytona'), { order: ORDER })
  if (problem) throw new UsageError(problem)
}

/** What's wrong with a Daytona descriptor from any source, or undefined; `maxConcurrent` is left out. */
export const daytonaProblem = (value: DaytonaSandboxDescriptor) =>
  refusal(daytonaSandboxSchema, value, explain('daytona'), {
    order: ['kind', 'apiKey', 'prefix', 'id', 'size', 'reuse', 'attemptsPerMachine'],
    skip: ['maxConcurrent'],
  })
