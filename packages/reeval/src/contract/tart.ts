// The Tart sandbox descriptor's plain-data contract: what `tart()` returns and what a declaration
// tree from any language carries. The type in types.ts has the TSDoc; `_SameAsSchema` holds the
// two together.
import { z } from 'zod'
import { UsageError } from '../errors.ts'
import type { TartSandboxDescriptor } from '../types.ts'
import { type Assert, closest, got, type Issue, nonEmpty, refusal, type Same } from './shared.ts'

/** macOS runs at most two macOS VMs at a time, whatever else is running. */
export const TART_MAX_CONCURRENT = 2

/** A memory size as `docker({ memory })` takes it: bytes, or a number with `b`, `k`, `m` or `g`. */
const MEMORY = /^\d+(\.\d+)?[bkmg]?$/i

const fields = {
  id: nonEmpty().optional(),
  image: z.string().regex(/^\S+$/, 'one word'),
  maxConcurrent: z.number().optional(),
  cpus: z.int().positive().optional(),
  memory: z.union([z.string().regex(MEMORY), z.int().positive()]).optional(),
  ssh: z.strictObject({ user: nonEmpty().optional(), key: nonEmpty() }).optional(),
}

export const tartSandboxSchema = z.strictObject({ kind: z.literal('tart'), ...fields })

/** `tart()`'s argument: the descriptor's fields, with `ssh.key` relative or a `file:` URL. */
export const tartOptionsSchema = z.strictObject({
  ...fields,
  ssh: z
    .strictObject({ user: nonEmpty().optional(), key: z.union([nonEmpty(), z.instanceof(URL)]) })
    .optional(),
})

/** `tart()`'s argument, as users write it. */
export type TartOptions = Omit<TartSandboxDescriptor, 'kind' | 'ssh'> & {
  /** `key` is relative to the file that calls `tart()`, or an absolute path or `URL`. */
  ssh?: { user?: string; key: string | URL }
}

export type _SameAsSchema = [
  Assert<Same<z.infer<typeof tartSandboxSchema>, TartSandboxDescriptor>>,
  Assert<Same<keyof z.infer<typeof tartSandboxSchema>, keyof TartSandboxDescriptor>>,
  Assert<Same<z.input<typeof tartOptionsSchema>, TartOptions>>,
]

/** What `docker()` takes that a VM has no use for, and why. */
const DOCKER_ONLY: Record<string, string> = {
  from: 'a Tart VM starts from its image, and reeval bakes only the harness onto it',
  dockerfile: 'a Tart VM starts from its image, and reeval bakes only the harness onto it',
  install:
    'a Tart VM starts from its image, and reeval bakes only the harness onto it; put install commands in the environment setup',
  root: 'the VM runs everything as the image user',
  capabilities: 'a macOS VM has no Linux capabilities',
  swap: 'macOS manages its own swap',
  pids: 'a macOS VM has no process limit',
  engine: 'Tart is its only engine',
}

const FIELD: Record<string, (value: unknown) => string> = {
  id: (v) => `tart({ id }) must be a non-empty string (got ${got(v)})`,
  image: (v) =>
    `tart({ image }) takes an OCI image or a local VM name with no spaces, e.g. image: 'ghcr.io/cirruslabs/macos-sequoia-base:latest' (got ${got(v)})`,
  maxConcurrent: (v) => `tart({ maxConcurrent }) takes a number (got ${got(v)})`,
  cpus: (v) => `tart({ cpus }) takes a whole number of CPUs above zero (got ${got(v)})`,
  memory: (v) => `tart({ memory }) takes a size such as '8g' or '4096m', or bytes (got ${got(v)})`,
  ssh: (v) =>
    `tart({ ssh }) takes { user?, key }, where key is the path of a private key the image trusts (got ${got(v)})`,
  kind: (v) => `a Tart sandbox's kind is "tart" (got ${got(v)})`,
}

const ORDER = ['kind', 'image', 'id', 'cpus', 'memory', 'ssh']

function explainTart(issue: Issue, value: unknown): string {
  const options = value as Record<string, unknown>
  if (issue.code === 'unrecognized_keys' && issue.path.length === 0) {
    const key = issue.keys[0] as string
    if (DOCKER_ONLY[key]) return `tart() has no "${key}": ${DOCKER_ONLY[key]}.`
    if (key === 'environment' || key === 'env') {
      return `Unknown tart() option "${key}". Variables and secrets belong in defineEnvironment({ env }).`
    }
    const near = closest(key, Object.keys(fields))
    return `Unknown tart() option "${key}".${near ? ` Did you mean "${near}"?` : ''}`
  }
  const key = String(issue.path[0])
  return (FIELD[key] ?? ((v) => `tart({ ${key} }) is invalid (got ${got(v)})`))(options[key])
}

/** `tart()`'s options, checked; throws reeval's sentence for the first problem. */
export function checkTartOptions(options: TartOptions): void {
  const problem = refusal(tartOptionsSchema, options, explainTart, { order: ORDER })
  if (problem) throw new UsageError(problem)
  if ((options.maxConcurrent ?? 0) > TART_MAX_CONCURRENT) {
    throw new UsageError(
      `tart({ maxConcurrent }) is ${options.maxConcurrent}, but macOS runs at most ${TART_MAX_CONCURRENT} macOS VMs at a time`,
    )
  }
}

/** What's wrong with a Tart descriptor from any source, or undefined; `maxConcurrent` aside. */
export const tartProblem = (value: TartSandboxDescriptor) =>
  refusal(tartSandboxSchema, value, explainTart, { order: ORDER, skip: ['maxConcurrent'] })
