// An image recipe's fields, shared by every sandbox that builds an image: `docker()`, `podman()`,
// `daytona()` and `boat()`. Each one's refusals name the function the user called.
import { z } from 'zod'
import { closest, durationProblem, durationSchema, got, nonEmpty } from './shared.ts'

export const installStepSchema = z.union([
  nonEmpty(),
  z.strictObject({
    run: nonEmpty(),
    timeout: durationSchema.optional(),
  }),
])

/** The recipe's fields but `dockerfile`, whose type differs between a descriptor and options. */
export const recipeFields = {
  image: nonEmpty().optional(),
  from: z.string().regex(/^\S+$/, 'one word').optional(),
  install: z.array(installStepSchema).min(1).optional(),
}

const BASES = ['image', 'from', 'dockerfile'] as const

export function oneRecipe(value: Record<string, unknown>, ctx: z.RefinementCtx): void {
  const bases = BASES.filter((k) => value[k] !== undefined)
  if (bases.length > 1) ctx.addIssue({ code: 'custom', message: 'one base', params: { bases } })
  else if (value.dockerfile !== undefined && value.install !== undefined) {
    ctx.addIssue({ code: 'custom', message: 'dockerfile or install' })
  }
}

/** The sentence for a recipe's `oneRecipe` issue. */
export function recipeMessage(fn: string, params: unknown): string {
  const { bases } = (params ?? {}) as { bases?: string[] }
  return bases
    ? `${fn}() takes one base image, but got ${bases.join(' and ')}. Use image (has the harness), from (a toolchain image reeval bakes the harness onto) or dockerfile.`
    : `${fn}() takes dockerfile or install, not both: put the install commands in the Dockerfile as RUN lines, so there's one recipe for the image.`
}

/** The sentence for a recipe field whose value the schema refused, or undefined for another field. */
export function recipeFieldMessage(fn: string, key: string, v: unknown): string | undefined {
  switch (key) {
    case 'image':
      return `${fn}({ image }) must be a non-empty string (got ${got(v)})`
    case 'from':
      return `${fn}({ from }) takes an image reference with no spaces or line breaks, e.g. from: 'python:3.12-slim' (got ${got(v)})`
    case 'dockerfile':
      return `${fn}({ dockerfile }) takes a path, e.g. dockerfile: './Dockerfile' (got ${got(v)})`
    case 'install':
      return `${fn}({ install }) takes a non-empty list of shell commands, e.g. install: ['apt-get update && apt-get install -y jq'] (got ${got(v)})`
    default:
      return undefined
  }
}

// Zod reports a bad timeout inside the step's union, so the step itself says which sentence fits.
export function installMessage(fn: string, step: unknown): string {
  const { run, timeout } = (typeof step === 'object' && step !== null ? step : {}) as {
    run?: unknown
    timeout?: unknown
  }
  const keys = typeof step === 'object' && step !== null ? Object.keys(step) : []
  if (typeof run === 'string' && run.trim()) {
    const extra = keys.find((k) => k !== 'run' && k !== 'timeout')
    if (extra) {
      const hint = closest(extra, ['timeout']) ? ' Did you mean "timeout"?' : ''
      return `${fn}({ install }) command "${run}" has an unknown key "${extra}"; a command is a string or { run, timeout? }.${hint}`
    }
    const problem = timeout === undefined ? undefined : durationProblem(timeout)
    if (problem) return `${fn}({ install }) command "${run}": ${problem}`
  }
  return `${fn}({ install }) commands are strings or { run, timeout? } objects (got ${got(step)})`
}
