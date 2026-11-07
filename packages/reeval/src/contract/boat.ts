// The boat.dev sandbox's plain-data contract: what `boat()` returns and what a declaration tree from
// any language carries. The types in types.ts are the ones users hover, held to these schemas by
// `_SameAsSchema` below.
import { z } from 'zod'
import { UsageError } from '../errors.ts'
import type { BoatApiKey, BoatMachineType, BoatSandboxDescriptor } from '../types.ts'
import { VAR } from './plain.ts'
import { type Assert, closest, got, type Issue, nonEmpty, refusal, type Same } from './shared.ts'

/**
 * Boat's names are 1–63 lowercase letters, digits or dashes. reeval adds `-<run>-<attempt>` (16
 * characters) to a sandbox's prefix and `-<harness>-<hash>` (up to 25) to a snapshot's.
 */
export const BOAT_PREFIX = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
export const BOAT_PREFIX_MAX = 32

export const BOAT_TYPES = ['small', 'default', 'large', 'xlarge'] as const
/** Slot `n` listens on the gateway's port plus `n`, and a small VM has 2 vCPUs. */
export const BOAT_ATTEMPTS_PER_MACHINE_MAX = 8

const apiKeySchema = z.strictObject({ kind: z.literal('secret'), from: z.string().regex(VAR) })
const prefixSchema = z.string().max(BOAT_PREFIX_MAX).regex(BOAT_PREFIX)
const typeSchema = z.enum(BOAT_TYPES)

export const boatSandboxSchema = z.strictObject({
  kind: z.literal('boat'),
  id: nonEmpty().optional(),
  apiKey: apiKeySchema,
  prefix: prefixSchema,
  type: typeSchema.optional(),
  maxConcurrent: z.number().optional(),
  reuse: z.boolean().optional(),
  attemptsPerMachine: z.number().int().min(1).max(BOAT_ATTEMPTS_PER_MACHINE_MAX).optional(),
})

/** `createBoat()`'s argument: the account and naming every sandbox of the factory shares. */
export type CreateBoatOptions = {
  /** The host variable with the API key, as `secret.fromEnv('BOAT_API_KEY')`. Default `BOAT_API_KEY`. */
  apiKey?: BoatApiKey
  /** The start of every sandbox name. Default `reeval`. */
  prefix?: string
}

/** `boat()`'s argument. */
export type BoatOptions = Omit<BoatSandboxDescriptor, 'kind' | 'apiKey' | 'prefix'>

export const createBoatOptionsSchema = z.strictObject({
  apiKey: apiKeySchema.optional(),
  prefix: prefixSchema.optional(),
})

export const boatOptionsSchema = z.strictObject({
  id: nonEmpty().optional(),
  type: typeSchema.optional(),
  maxConcurrent: z.number().optional(),
  reuse: z.boolean().optional(),
  attemptsPerMachine: z.number().int().min(1).max(BOAT_ATTEMPTS_PER_MACHINE_MAX).optional(),
})

export type _SameAsSchema = [
  Assert<Same<z.infer<typeof boatSandboxSchema>, BoatSandboxDescriptor>>,
  Assert<Same<keyof z.infer<typeof boatSandboxSchema>, keyof BoatSandboxDescriptor>>,
  Assert<Same<z.infer<typeof apiKeySchema>, BoatApiKey>>,
  Assert<Same<z.infer<typeof typeSchema>, BoatMachineType>>,
  Assert<Same<z.input<typeof createBoatOptionsSchema>, CreateBoatOptions>>,
  Assert<Same<z.input<typeof boatOptionsSchema>, BoatOptions>>,
]

/** Docker's options, which a Boat VM doesn't have (yet), and what to do instead. */
const NOT_ON_BOAT: Record<string, string> = {
  image:
    "Boat VMs start from boat's own Ubuntu 24.04 base, and the harness installs as the attempt starts",
  from: "Boat VMs start from boat's own Ubuntu 24.04 base; run your toolchain's installs in the environment's setup",
  dockerfile:
    "Boat VMs start from boat's own Ubuntu 24.04 base; run your toolchain's installs in the environment's setup",
  install: "run them in the environment's setup, which runs in the VM before the agent starts",
  root: 'the agent, setup steps and checks run as the unprivileged reeval user, and a Boat sandbox has no root mode yet',
  capabilities: 'a VM has no container capabilities to add',
  memory: "pick a machine size with type: 'small' (4 GB), 'default', 'large' or 'xlarge'",
  cpus: "pick a machine size with type: 'small' (2 vCPUs), 'default', 'large' or 'xlarge'",
  swap: "pick a machine size with type: 'small' (4 GB), 'default', 'large' or 'xlarge'",
  pids: 'a VM has no container process limit',
  engine: 'boat() runs on boat.dev, not a container engine',
}

const prefixMessage = (v: unknown, where: string) =>
  `${where} takes lowercase letters, digits and dashes, starting and ending with a letter or digit, at most ${BOAT_PREFIX_MAX} characters, e.g. prefix: 'acme-evals' (got ${got(v)})`

function explain(fn: string) {
  return (issue: Issue, value: unknown): string => {
    const options = (value ?? {}) as Record<string, unknown>
    if (issue.code === 'unrecognized_keys' && issue.path.length === 0) {
      const key = issue.keys[0] as string
      if (NOT_ON_BOAT[key]) return `${fn}() doesn't take ${key}: ${NOT_ON_BOAT[key]}.`
      const known =
        fn === 'createBoat'
          ? ['apiKey', 'prefix']
          : ['id', 'type', 'maxConcurrent', 'reuse', 'attemptsPerMachine']
      const near = closest(key, known)
      return `Unknown ${fn}() option "${key}".${near ? ` Did you mean "${near}"?` : ''}`
    }
    const key = String(issue.path[0])
    const v = options[key]
    switch (key) {
      case 'apiKey':
        return typeof v === 'string'
          ? `${fn}({ apiKey }) takes the host variable that holds the key, never the key: apiKey: secret.fromEnv('BOAT_API_KEY'), with secret from a defineConfig callback. The key stays on the host.`
          : `${fn}({ apiKey }) takes secret.fromEnv('<HOST_VARIABLE>') (got ${got(v)})`
      case 'prefix':
        return prefixMessage(v, `${fn}({ prefix })`)
      case 'type':
        return `${fn}({ type }) is one of ${BOAT_TYPES.map((t) => `'${t}'`).join(', ')} (got ${got(v)})`
      case 'id':
        return `${fn}({ id }) must be a non-empty string (got ${got(v)})`
      case 'maxConcurrent':
        return `${fn}({ maxConcurrent }) takes a number (got ${got(v)})`
      case 'reuse':
        return `${fn}({ reuse }) is true or false (got ${got(v)})`
      case 'attemptsPerMachine':
        return `${fn}({ attemptsPerMachine }) is a whole number from 1 to ${BOAT_ATTEMPTS_PER_MACHINE_MAX} (got ${got(v)})`
      case 'kind':
        return `a Boat sandbox's kind is "boat" (got ${got(v)})`
      default:
        return `${fn}({ ${key} }) is invalid (got ${got(v)})`
    }
  }
}

/** `createBoat()`'s options, checked; throws reeval's sentence for the first problem. */
export function checkCreateBoatOptions(options: unknown): void {
  const problem = refusal(createBoatOptionsSchema, options, explain('createBoat'), {
    order: ['apiKey', 'prefix'],
  })
  if (problem) throw new UsageError(problem)
}

/** `boat()`'s options, checked; throws reeval's sentence for the first problem. */
export function checkBoatOptions(options: unknown): void {
  const problem = refusal(boatOptionsSchema, options, explain('boat'), {
    order: ['id', 'type', 'maxConcurrent', 'reuse', 'attemptsPerMachine'],
  })
  if (problem) throw new UsageError(problem)
}

/** What's wrong with a Boat descriptor from any source, or undefined; `maxConcurrent` is left out. */
export const boatProblem = (value: BoatSandboxDescriptor) =>
  refusal(boatSandboxSchema, value, explain('boat'), {
    order: ['kind', 'apiKey', 'prefix', 'id', 'type', 'reuse', 'attemptsPerMachine'],
    skip: ['maxConcurrent'],
  })
