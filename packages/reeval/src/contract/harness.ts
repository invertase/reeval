// The harness descriptors' plain-data contract: what `cursor()`, `claudeCode()` and the other
// factories in `reeval/harness` return, and what a declaration tree from any language carries.
// One schema per kind, joined on `kind`; the types in types.ts are held to them by
// `_SameAsSchema`.
import { z } from 'zod'
import { MAX_TIMER_MS, TIMER_LIMIT } from '../duration.ts'
import type {
  AntigravityHarnessDescriptor,
  ClaudeCodeHarnessDescriptor,
  CodexHarnessDescriptor,
  CursorHarnessDescriptor,
  FakeHarnessDescriptor,
  FakeScriptStep,
  FxHarnessDescriptor,
  GooseHarnessDescriptor,
  GrokBuildHarnessDescriptor,
  HarnessDescriptor,
  OpenCodeHarnessDescriptor,
  PiHarnessDescriptor,
} from '../types.ts'
import { GATEWAY_NAMES, gatewayNameSchema } from './gateway.ts'
import {
  type Assert,
  closest,
  durationSchema,
  genericProblem,
  got,
  type Issue,
  nonEmpty,
  refusal,
  type Same,
} from './shared.ts'

/** A model id with no provider prefix. */
const BARE_MODEL = /^[\w.-]+$/

export const cursorHarnessSchema = z.strictObject({
  kind: z.literal('cursor'),
  gateway: gatewayNameSchema.optional(),
  model: z.string().min(1),
  params: z.record(z.string(), z.string()).optional(),
  effort: nonEmpty().optional(),
  id: nonEmpty().optional(),
  maxConcurrent: z.number().optional(),
  startTimeout: durationSchema.optional(),
})

export const CLAUDE_CODE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export const claudeCodeEffortSchema = z.enum(CLAUDE_CODE_EFFORTS)

export const claudeCodeHarnessSchema = z.strictObject({
  kind: z.literal('claude-code'),
  gateway: gatewayNameSchema.optional(),
  model: z.string().min(1),
  effort: claudeCodeEffortSchema.optional(),
  id: nonEmpty().optional(),
  maxConcurrent: z.number().optional(),
  startTimeout: durationSchema.optional(),
})

export const antigravityHarnessSchema = z.strictObject({
  kind: z.literal('antigravity'),
  gateway: gatewayNameSchema.optional(),
  model: z.string().min(1),
  effort: nonEmpty().optional(),
  id: nonEmpty().optional(),
  maxConcurrent: z.number().optional(),
  startTimeout: durationSchema.optional(),
})

export const opencodeHarnessSchema = z.strictObject({
  kind: z.literal('opencode'),
  gateway: gatewayNameSchema.optional(),
  model: z.string().min(1),
  effort: nonEmpty().optional(),
  id: nonEmpty().optional(),
  maxConcurrent: z.number().optional(),
  startTimeout: durationSchema.optional(),
})

export const gooseHarnessSchema = z.strictObject({
  kind: z.literal('goose'),
  gateway: gatewayNameSchema.optional(),
  model: z.string().regex(BARE_MODEL),
  effort: nonEmpty().optional(),
  id: nonEmpty().optional(),
  maxConcurrent: z.number().optional(),
  startTimeout: durationSchema.optional(),
})

export const fxHarnessSchema = z.strictObject({
  kind: z.literal('fx'),
  gateway: gatewayNameSchema.optional(),
  model: z.string().min(1),
  effort: nonEmpty().optional(),
  id: nonEmpty().optional(),
  maxConcurrent: z.number().optional(),
  startTimeout: durationSchema.optional(),
})

export const piHarnessSchema = z.strictObject({
  kind: z.literal('pi'),
  gateway: gatewayNameSchema.optional(),
  model: z.string().regex(BARE_MODEL),
  effort: nonEmpty().optional(),
  id: nonEmpty().optional(),
  maxConcurrent: z.number().optional(),
  startTimeout: durationSchema.optional(),
})

export const codexHarnessSchema = z.strictObject({
  kind: z.literal('codex'),
  gateway: gatewayNameSchema.optional(),
  model: z.string().regex(BARE_MODEL),
  effort: nonEmpty().optional(),
  id: nonEmpty().optional(),
  maxConcurrent: z.number().optional(),
  startTimeout: durationSchema.optional(),
})

export const grokBuildHarnessSchema = z.strictObject({
  kind: z.literal('grok-build'),
  gateway: gatewayNameSchema.optional(),
  model: z.string().regex(BARE_MODEL),
  effort: nonEmpty().optional(),
  id: nonEmpty().optional(),
  maxConcurrent: z.number().optional(),
  startTimeout: durationSchema.optional(),
})

export const fakeScriptStepSchema = z.union([
  z.strictObject({ exec: z.string() }),
  z.strictObject({ write: z.record(z.string(), z.string()) }),
  z.strictObject({ reply: z.string() }),
  z.strictObject({ mcp: z.string().regex(/^[^/]+\/[^/]+$/) }),
  z.strictObject({ error: z.string() }),
  z.strictObject({ refuseKey: nonEmpty() }),
])

export const FAKE_LAYOUTS = [
  'cursor',
  'claude-code',
  'antigravity',
  'opencode',
  'goose',
  'pi',
  'codex',
  'fx',
  'grok-build',
] as const

export const fakeHarnessSchema = z.strictObject({
  kind: z.literal('fake'),
  gateway: gatewayNameSchema.optional(),
  id: nonEmpty().optional(),
  files: z.record(z.string(), z.string()).optional(),
  text: z.string().optional(),
  delayMs: z.number().max(MAX_TIMER_MS, `must be ${TIMER_LIMIT}`).optional(),
  ignoreAbort: z.boolean().optional(),
  failWith: z.string().optional(),
  startHangs: z.union([z.number(), z.literal(true)]).optional(),
  reasoning: z.string().optional(),
  servedModel: z.string().optional(),
  effort: nonEmpty().optional(),
  tools: z
    .array(
      z.strictObject({
        tool: z.string(),
        input: z.unknown(),
        output: z.unknown(),
        ok: z.boolean().nullable().optional(),
      }),
    )
    .optional(),
  withSkill: z
    .strictObject({
      files: z.record(z.string(), z.string()).optional(),
      text: z.string().optional(),
    })
    .optional(),
  flakeRate: z.number().optional(),
  script: z.array(z.array(fakeScriptStepSchema)).optional(),
  maxConcurrent: z.number().optional(),
  startTimeout: durationSchema.optional(),
  layout: z.enum(FAKE_LAYOUTS).optional(),
  brokers: z.literal(true).optional(),
})

const SCHEMAS = {
  fake: fakeHarnessSchema,
  cursor: cursorHarnessSchema,
  'claude-code': claudeCodeHarnessSchema,
  antigravity: antigravityHarnessSchema,
  opencode: opencodeHarnessSchema,
  goose: gooseHarnessSchema,
  pi: piHarnessSchema,
  codex: codexHarnessSchema,
  fx: fxHarnessSchema,
  'grok-build': grokBuildHarnessSchema,
} as const

export const harnessDescriptorSchema = z.discriminatedUnion('kind', [
  fakeHarnessSchema,
  cursorHarnessSchema,
  claudeCodeHarnessSchema,
  antigravityHarnessSchema,
  opencodeHarnessSchema,
  gooseHarnessSchema,
  piHarnessSchema,
  codexHarnessSchema,
  fxHarnessSchema,
  grokBuildHarnessSchema,
])

export type _SameAsSchema = [
  Assert<Same<z.infer<typeof cursorHarnessSchema>, CursorHarnessDescriptor>>,
  Assert<Same<keyof z.infer<typeof cursorHarnessSchema>, keyof CursorHarnessDescriptor>>,
  Assert<Same<z.infer<typeof claudeCodeHarnessSchema>, ClaudeCodeHarnessDescriptor>>,
  Assert<Same<keyof z.infer<typeof claudeCodeHarnessSchema>, keyof ClaudeCodeHarnessDescriptor>>,
  Assert<Same<z.infer<typeof antigravityHarnessSchema>, AntigravityHarnessDescriptor>>,
  Assert<Same<keyof z.infer<typeof antigravityHarnessSchema>, keyof AntigravityHarnessDescriptor>>,
  Assert<Same<z.infer<typeof opencodeHarnessSchema>, OpenCodeHarnessDescriptor>>,
  Assert<Same<keyof z.infer<typeof opencodeHarnessSchema>, keyof OpenCodeHarnessDescriptor>>,
  Assert<Same<z.infer<typeof gooseHarnessSchema>, GooseHarnessDescriptor>>,
  Assert<Same<keyof z.infer<typeof gooseHarnessSchema>, keyof GooseHarnessDescriptor>>,
  Assert<Same<z.infer<typeof piHarnessSchema>, PiHarnessDescriptor>>,
  Assert<Same<keyof z.infer<typeof piHarnessSchema>, keyof PiHarnessDescriptor>>,
  Assert<Same<z.infer<typeof codexHarnessSchema>, CodexHarnessDescriptor>>,
  Assert<Same<keyof z.infer<typeof codexHarnessSchema>, keyof CodexHarnessDescriptor>>,
  Assert<Same<z.infer<typeof fxHarnessSchema>, FxHarnessDescriptor>>,
  Assert<Same<keyof z.infer<typeof fxHarnessSchema>, keyof FxHarnessDescriptor>>,
  Assert<Same<z.infer<typeof grokBuildHarnessSchema>, GrokBuildHarnessDescriptor>>,
  Assert<Same<keyof z.infer<typeof grokBuildHarnessSchema>, keyof GrokBuildHarnessDescriptor>>,
  Assert<Same<z.infer<typeof fakeHarnessSchema>, FakeHarnessDescriptor>>,
  Assert<Same<keyof z.infer<typeof fakeHarnessSchema>, keyof FakeHarnessDescriptor>>,
  Assert<Same<z.infer<typeof fakeScriptStepSchema>, FakeScriptStep>>,
  Assert<Same<z.infer<typeof harnessDescriptorSchema>, HarnessDescriptor>>,
]

/** The factory in `reeval/harness` that makes each kind, as messages name it. */
export const FACTORY: Record<HarnessDescriptor['kind'], string> = {
  fake: 'fakeHarness',
  cursor: 'cursor',
  'claude-code': 'claudeCode',
  antigravity: 'antigravity',
  opencode: 'opencode',
  goose: 'goose',
  pi: 'pi',
  codex: 'codex',
  fx: 'fx',
  'grok-build': 'grokBuild',
}

const MODEL: Partial<Record<HarnessDescriptor['kind'], (v: unknown) => string>> = {
  cursor: () => "cursor() needs a model, e.g. cursor({ model: 'composer-2.5' })",
  'claude-code': () => "claudeCode() needs a model, e.g. claudeCode({ model: 'claude-sonnet-5' })",
  antigravity: () =>
    "antigravity() needs a model, e.g. antigravity({ model: 'gemini-3.8-flash-medium' })",
  opencode: (v) =>
    `opencode(): needs a model, <provider>/<model>, e.g. opencode({ model: 'google/gemini-3.8-flash' }) (got ${got(v)})`,
  goose: (v) =>
    `goose() needs a Gemini model id, without a provider, since it runs on a Gemini API key, e.g. goose({ model: 'gemini-3.8-flash' }) (got ${got(v)})`,
  pi: (v) =>
    `pi() needs a Gemini model id, without a provider, since it runs on a Gemini API key, e.g. pi({ model: 'gemini-3.8-flash' }) (got ${got(v)})`,
  codex: (v) =>
    `codex() needs an OpenAI model id, without a provider, since it runs on an OpenAI API key, e.g. codex({ model: 'gpt-5.6-luna' }) (got ${got(v)})`,
  fx: (v) =>
    `fx() needs a model: a Vercel AI Gateway id, e.g. fx({ model: 'anthropic/claude-sonnet-5' }), or a bare OpenAI id, e.g. fx({ model: 'gpt-5.5' }) (got ${got(v)})`,
  'grok-build': (v) =>
    `grokBuild() needs an xAI model id, without a provider, since it runs on an xAI API key, e.g. grokBuild({ model: 'grok-4.6' }) (got ${got(v)})`,
}

const SCRIPT_EXAMPLE = "script: [[{ exec: 'cat notes.txt' }, { reply: 'done' }]]"

/** The order the factories have always checked in, so the first refusal stays the same. */
const ORDER = ['kind', 'model', 'params', 'effort', 'script', 'layout']

function explain(kind: HarnessDescriptor['kind']) {
  const factory = FACTORY[kind]
  return (issue: Issue, value: unknown): string => {
    const options = value as Record<string, unknown>
    if (issue.code === 'unrecognized_keys' && issue.path.length === 0) {
      const key = issue.keys[0] as string
      const near = closest(key, Object.keys(SCHEMAS[kind].shape))
      return `Unknown ${factory}() option "${key}".${near ? ` Did you mean "${near}"?` : ''}`
    }
    const [key, turn, step] = issue.path as [string, number?, number?]
    const v = options[key]
    if (key === 'model') return (MODEL[kind] as (v: unknown) => string)(v)
    if (key === 'effort') {
      if (kind === 'claude-code' && typeof v === 'string' && v.trim()) {
        return `claudeCode({ effort }) must be low, medium, high, xhigh or max (got ${got(v)})`
      }
      return `${factory}({ effort }) is the value that CLI takes, e.g. ${factory}({ effort: 'high' }) (got ${got(v)})`
    }
    if (key === 'params') {
      const bad =
        v && typeof v === 'object'
          ? Object.entries(v).find(([, value]) => typeof value !== 'string')
          : undefined
      if (bad && (typeof bad[1] === 'boolean' || typeof bad[1] === 'number')) {
        return `cursor({ params }) values are strings, as Cursor's model catalog lists them: write ${bad[0]}: '${bad[1]}', not ${bad[0]}: ${bad[1]}`
      }
      return `cursor({ params }) maps parameter ids to string values, e.g. { fast: 'false' } (got ${got(v)})`
    }
    if (key === 'script') {
      if (step === undefined) {
        return `fakeHarness({ script }) takes one list of steps per turn, e.g. ${SCRIPT_EXAMPLE} (got ${got(v)})`
      }
      const at = (v as unknown[][])[turn as number]?.[step]
      return `fakeHarness({ script }) steps are { exec: string }, { write: { path: content } }, { reply: string }, { mcp: '<server>/<tool>' } or { error: string } (got ${got(at)})`
    }
    if (key === 'layout') {
      return `fakeHarness({ layout }) is one of ${FAKE_LAYOUTS.map((l) => `'${l}'`).join(', ')} (got ${got(v)})`
    }
    if (key === 'id') return `${factory}({ id }) must be a non-empty string (got ${got(v)})`
    if (key === 'gateway') {
      return `${factory}({ gateway }) names a gateway in the config's gateway list: ${GATEWAY_NAMES.map((g) => `'${g}'`).join(' or ')} (got ${got(v)})`
    }
    return genericProblem(factory, issue, value)
  }
}

/**
 * Claude Code drops `effort` for these models and sends none (claude-code 2.1.290's
 * `supportsEffort`): every `claude-3-` model, and the ones named.
 */
const CLAUDE_CODE_NO_EFFORT = new Set([
  'claude-opus-4-0',
  'claude-opus-4-1',
  'claude-sonnet-4-0',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
])

/** `claude-haiku-4-5` from `claude-haiku-4-5@20251001` or `claude-haiku-4-5-20251001`. */
const claudeBase = (model: string) =>
  model
    .toLowerCase()
    .replace(/@.*$/, '')
    .replace(/-\d{8}$/, '')

/** Whether Claude Code sends an effort to `model`. */
export const claudeCodeTakesEffort = (model: string): boolean => {
  const base = claudeBase(model)
  return !base.includes('claude-3-') && !CLAUDE_CODE_NO_EFFORT.has(base)
}

/** Antigravity model ids that name their effort, e.g. `gemini-3.8-flash-low`. */
const ANTIGRAVITY_EFFORT_ID = /-(minimal|low|medium|high|max)$/

/** The effort an Antigravity model id names, e.g. `low` for `gemini-3.8-flash-low`. */
export const antigravityIdEffort = (model: string): string | undefined =>
  model.match(ANTIGRAVITY_EFFORT_ID)?.[1]

/** Why `value` sets an effort its model can't take, in its factory's words, or undefined. */
function effortProblem(value: HarnessDescriptor): string | undefined {
  if (value.kind === 'claude-code' && value.effort && !claudeCodeTakesEffort(value.model)) {
    return `claudeCode({ effort }): Claude Code sends no effort to ${value.model}, so drop effort or run a model that takes one, e.g. claude-sonnet-5-5`
  }
  if (value.kind === 'antigravity' && value.effort) {
    const named = antigravityIdEffort(value.model)
    if (named) {
      return `antigravity({ effort }): the model id ${value.model} names its effort (${named}), which the CLI refuses beside --effort; drop effort, or name the model without its -${named}`
    }
  }
  return undefined
}

/**
 * What's wrong with a harness descriptor of a known kind, in the words its factory uses, or
 * undefined. `maxConcurrent` and `startTimeout` are left to the check that names where they were
 * set.
 */
export function harnessProblem(value: HarnessDescriptor): string | undefined {
  return (
    refusal(SCHEMAS[value.kind], value, explain(value.kind), {
      order: ORDER,
      skip: ['maxConcurrent', 'startTimeout'],
    }) ?? effortProblem(value)
  )
}
