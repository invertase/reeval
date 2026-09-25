// `evalsuite/harness`: agent harness descriptors. The implementations load lazily in workers.
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

/** The Claude Code CLI. `id` names the cell; it defaults to `claude-code:<model>`. */
export const claudeCode = (
  options: Omit<ClaudeCodeHarnessDescriptor, 'kind'>,
): ClaudeCodeHarnessDescriptor => ({
  kind: 'claude-code',
  ...options,
})

/** A fake agent that writes canned files and replies with canned text. For tests and dry runs. */
export const fakeHarness = (options: Omit<FakeHarnessDescriptor, 'kind'> = {}) =>
  ({ kind: 'fake', ...options }) satisfies FakeHarnessDescriptor

export type {
  AgentHarnessDescriptor,
  ClaudeCodeHarnessDescriptor,
  CursorHarnessDescriptor,
  FakeHarnessDescriptor,
  HarnessDescriptor,
} from './types.ts'
