// The cloud sandbox's plain-data contract: what `cloud()` returns and what a declaration tree from
// any language carries. The types in types.ts are the ones users hover, held to these schemas by
// `_SameAsSchema` below.
import { z } from 'zod'
import { UsageError } from '../errors.ts'
import type { CloudMachineSize, CloudSandboxDescriptor } from '../types.ts'
import { BOAT_ATTEMPTS_PER_MACHINE_MAX } from './boat.ts'
import { type Assert, closest, got, type Issue, nonEmpty, refusal, type Same } from './shared.ts'

export const CLOUD_SIZES = ['small', 'medium', 'large', 'xlarge'] as const
/** Slot `n` listens on the gateway's port plus `n`, and a small VM has 2 vCPUs. */
export const CLOUD_ATTEMPTS_PER_MACHINE_MAX = BOAT_ATTEMPTS_PER_MACHINE_MAX

const sizeSchema = z.enum(CLOUD_SIZES)
const attemptsSchema = z.number().int().min(1).max(CLOUD_ATTEMPTS_PER_MACHINE_MAX)

export const cloudSandboxSchema = z.strictObject({
  kind: z.literal('cloud'),
  id: nonEmpty().optional(),
  size: sizeSchema.optional(),
  maxConcurrent: z.number().optional(),
  reuse: z.boolean().optional(),
  attemptsPerMachine: attemptsSchema.optional(),
})

/** `cloud()`'s argument. */
export type CloudOptions = Omit<CloudSandboxDescriptor, 'kind'>

export const cloudOptionsSchema = z.strictObject({
  id: nonEmpty().optional(),
  size: sizeSchema.optional(),
  maxConcurrent: z.number().optional(),
  reuse: z.boolean().optional(),
  attemptsPerMachine: attemptsSchema.optional(),
})

export type _SameAsSchema = [
  Assert<Same<z.infer<typeof cloudSandboxSchema>, CloudSandboxDescriptor>>,
  Assert<Same<keyof z.infer<typeof cloudSandboxSchema>, keyof CloudSandboxDescriptor>>,
  Assert<Same<z.infer<typeof sizeSchema>, CloudMachineSize>>,
  Assert<Same<z.input<typeof cloudOptionsSchema>, CloudOptions>>,
]

const SIZES =
  "pick a machine size with size: 'small' (2 vCPUs, 4 GB), 'medium', 'large' or 'xlarge'"
const BASE = 'cloud VMs start from Ubuntu 24.04, and the harness installs as the attempt starts'

/** Docker's options, which a cloud VM doesn't have, and what to do instead. */
const NOT_CLOUD: Record<string, string> = {
  image: BASE,
  from: `${BASE}; run your toolchain's installs in the environment's setup`,
  dockerfile: `${BASE}; run your toolchain's installs in the environment's setup`,
  install: "run them in the environment's setup, which runs in the VM before the agent starts",
  root: 'the agent, setup steps and checks run as the unprivileged reeval user, and a cloud VM has no root mode',
  capabilities: 'a VM has no container capabilities to add',
  memory: SIZES,
  cpus: SIZES,
  swap: SIZES,
  type: SIZES,
  pids: 'a VM has no container process limit',
  engine: 'cloud() runs VMs, not a container engine',
  apiKey: 'its token comes from REEVAL_VM_TOKEN, so there is no key to name',
  prefix: 'reeval names its VMs itself',
}

const ORDER = ['id', 'size', 'maxConcurrent', 'reuse', 'attemptsPerMachine']

function explain(issue: Issue, value: unknown): string {
  const options = (value ?? {}) as Record<string, unknown>
  if (issue.code === 'unrecognized_keys' && issue.path.length === 0) {
    const key = issue.keys[0] as string
    if (NOT_CLOUD[key]) return `cloud() doesn't take ${key}: ${NOT_CLOUD[key]}.`
    const near = closest(key, ORDER)
    return `Unknown cloud() option "${key}".${near ? ` Did you mean "${near}"?` : ''}`
  }
  const key = String(issue.path[0])
  const v = options[key]
  switch (key) {
    case 'size':
      return `cloud({ size }) is one of ${CLOUD_SIZES.map((t) => `'${t}'`).join(', ')} (got ${got(v)})`
    case 'id':
      return `cloud({ id }) must be a non-empty string (got ${got(v)})`
    case 'maxConcurrent':
      return `cloud({ maxConcurrent }) takes a number (got ${got(v)})`
    case 'reuse':
      return `cloud({ reuse }) is true or false (got ${got(v)})`
    case 'attemptsPerMachine':
      return `cloud({ attemptsPerMachine }) is a whole number from 1 to ${CLOUD_ATTEMPTS_PER_MACHINE_MAX} (got ${got(v)})`
    case 'kind':
      return `a cloud sandbox's kind is "cloud" (got ${got(v)})`
    default:
      return `cloud({ ${key} }) is invalid (got ${got(v)})`
  }
}

/** `cloud()`'s options, checked; throws reeval's sentence for the first problem. */
export function checkCloudOptions(options: unknown): void {
  const problem = refusal(cloudOptionsSchema, options, explain, { order: ORDER })
  if (problem) throw new UsageError(problem)
}

/** What's wrong with a cloud descriptor from any source, or undefined; `maxConcurrent` is left out. */
export const cloudProblem = (value: CloudSandboxDescriptor) =>
  refusal(cloudSandboxSchema, value, explain, {
    order: ['kind', 'id', 'size', 'reuse', 'attemptsPerMachine'],
    skip: ['maxConcurrent'],
  })
