// `evalsuite/harness`: agent harness descriptors. The implementations load lazily in workers.
import type { CursorHarnessDescriptor, FakeHarnessDescriptor } from './types.ts'

export const cursor = (options: { model?: string } = {}): CursorHarnessDescriptor => ({
  kind: 'cursor',
  ...options,
})

/** A fake agent that writes canned files and replies with canned text. For tests and dry runs. */
export const fakeHarness = (options: Omit<FakeHarnessDescriptor, 'kind'> = {}) =>
  ({ kind: 'fake', ...options }) satisfies FakeHarnessDescriptor

export type { CursorHarnessDescriptor, FakeHarnessDescriptor, HarnessDescriptor } from './types.ts'
