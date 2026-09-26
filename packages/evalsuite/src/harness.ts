// `evalsuite/harness`: agent harness descriptors. The implementations load lazily in workers.
import { UsageError } from './errors.ts'
import type {
  AntigravityHarnessDescriptor,
  ClaudeCodeHarnessDescriptor,
  CursorHarnessDescriptor,
  FakeHarnessDescriptor,
  OpenCodeHarnessDescriptor,
} from './types.ts'

/**
 * Cursor's agent through the Cursor TypeScript SDK, in the sandbox. `model` is required (the SDK
 * has no default for local agents); `params` sets model parameters such as `{ fast: 'false' }`.
 * `id` names the cell; it defaults to `cursor:<model>`.
 */
export const cursor = (options: Omit<CursorHarnessDescriptor, 'kind'>): CursorHarnessDescriptor => {
  if (typeof options?.model !== 'string' || !options.model) {
    throw new UsageError("cursor() needs a model, e.g. cursor({ model: 'composer-2.5' })")
  }
  if (
    options.params !== undefined &&
    (typeof options.params !== 'object' ||
      options.params === null ||
      !Object.values(options.params).every((v) => typeof v === 'string'))
  ) {
    throw new UsageError(
      `cursor({ params }) maps parameter ids to string values, e.g. { fast: 'false' } (got ${JSON.stringify(options.params)})`,
    )
  }
  return { kind: 'cursor', ...options }
}

/**
 * The Claude Code CLI. `model` is required, since the CLI's default changes under you. `id`
 * names the cell; it defaults to `claude-code:<model>`.
 */
export const claudeCode = (
  options: Omit<ClaudeCodeHarnessDescriptor, 'kind'>,
): ClaudeCodeHarnessDescriptor => {
  if (typeof options?.model !== 'string' || !options.model) {
    throw new UsageError(
      "claudeCode() needs a model, e.g. claudeCode({ model: 'claude-sonnet-5' })",
    )
  }
  return { kind: 'claude-code', ...options }
}

/**
 * The Antigravity CLI, with a Gemini API key. `model` is required, since the CLI's default
 * changes under you. `id` names the cell; it defaults to `antigravity:<model>`.
 */
export const antigravity = (
  options: Omit<AntigravityHarnessDescriptor, 'kind'>,
): AntigravityHarnessDescriptor => {
  if (typeof options?.model !== 'string' || !options.model) {
    throw new UsageError(
      "antigravity() needs a model, e.g. antigravity({ model: 'gemini-3.8-flash-medium' })",
    )
  }
  return { kind: 'antigravity', ...options }
}

/**
 * OpenCode, with a Gemini API key: `model` is a Gemini model id, which it runs on its `google`
 * provider, since that's the only key it's given. `id` names the cell; it defaults to
 * `opencode:<model>`.
 */
export const opencode = (
  options: Omit<OpenCodeHarnessDescriptor, 'kind'>,
): OpenCodeHarnessDescriptor => {
  if (typeof options?.model !== 'string' || !/^[\w.-]+$/.test(options.model)) {
    throw new UsageError(
      `opencode() needs a Gemini model id, without a provider, since it runs on a Gemini API key, e.g. opencode({ model: 'gemini-3.8-flash' }) (got ${JSON.stringify(options?.model)})`,
    )
  }
  return { kind: 'opencode', ...options }
}

const LAYOUTS = ['cursor', 'claude-code', 'antigravity', 'opencode']

const STEP_KEYS = ['exec', 'write', 'reply', 'mcp', 'error']

function checkScript(script: unknown): void {
  const example = "script: [[{ exec: 'cat notes.txt' }, { reply: 'done' }]]"
  if (!Array.isArray(script) || !script.every(Array.isArray)) {
    throw new UsageError(
      `fakeHarness({ script }) takes one list of steps per turn, e.g. ${example} (got ${JSON.stringify(script)})`,
    )
  }
  for (const step of script.flat() as unknown[]) {
    const keys = typeof step === 'object' && step !== null ? Object.keys(step) : []
    const [key] = keys
    const value = key === undefined ? undefined : (step as Record<string, unknown>)[key]
    const valid =
      keys.length === 1 &&
      key !== undefined &&
      STEP_KEYS.includes(key) &&
      (key === 'write'
        ? typeof value === 'object' &&
          value !== null &&
          Object.values(value).every((c) => typeof c === 'string')
        : key === 'mcp'
          ? typeof value === 'string' && /^[^/]+\/[^/]+$/.test(value)
          : typeof value === 'string')
    if (!valid) {
      throw new UsageError(
        `fakeHarness({ script }) steps are { exec: string }, { write: { path: content } }, { reply: string }, { mcp: '<server>/<tool>' } or { error: string } (got ${JSON.stringify(step)})`,
      )
    }
  }
}

/** A fake agent that writes canned files and replies with canned text. For tests and dry runs. */
export const fakeHarness = (options: Omit<FakeHarnessDescriptor, 'kind'> = {}) => {
  if (options.script !== undefined) checkScript(options.script)
  if (options.layout !== undefined && !LAYOUTS.includes(options.layout)) {
    throw new UsageError(
      `fakeHarness({ layout }) is one of ${LAYOUTS.map((l) => `'${l}'`).join(', ')} (got ${JSON.stringify(options.layout)})`,
    )
  }
  return { kind: 'fake', ...options } satisfies FakeHarnessDescriptor
}

export type {
  AgentHarnessDescriptor,
  AntigravityHarnessDescriptor,
  ClaudeCodeHarnessDescriptor,
  CursorHarnessDescriptor,
  FakeHarnessDescriptor,
  FakeScriptStep,
  HarnessDescriptor,
  OpenCodeHarnessDescriptor,
} from './types.ts'
