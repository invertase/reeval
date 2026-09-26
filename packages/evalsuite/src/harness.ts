// `evalsuite/harness`: agent harness descriptors. The implementations load lazily in workers.
import { UsageError } from './errors.ts'
import type {
  ClaudeCodeHarnessDescriptor,
  CursorHarnessDescriptor,
  FakeHarnessDescriptor,
} from './types.ts'

/** The Cursor agent CLI. `id` names the cell; it defaults to `cursor:<model>`. */
export const cursor = (
  options: Omit<CursorHarnessDescriptor, 'kind'> = {},
): CursorHarnessDescriptor => ({
  kind: 'cursor',
  ...options,
})

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

const LAYOUTS = ['cursor', 'claude-code']

const STEP_KEYS = ['exec', 'write', 'reply', 'mcp']

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
        `fakeHarness({ script }) steps are { exec: string }, { write: { path: content } }, { reply: string } or { mcp: '<server>/<tool>' } (got ${JSON.stringify(step)})`,
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
  ClaudeCodeHarnessDescriptor,
  CursorHarnessDescriptor,
  FakeHarnessDescriptor,
  FakeScriptStep,
  HarnessDescriptor,
} from './types.ts'
