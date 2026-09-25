// `evalsuite/harness`: agent harness descriptors. The implementations load lazily in workers.
import { UsageError } from './errors.ts'
import type { CursorHarnessDescriptor, FakeHarnessDescriptor } from './types.ts'

/** The Cursor agent CLI. `id` names the cell; it defaults to `cursor:<model>`. */
export const cursor = (
  options: Omit<CursorHarnessDescriptor, 'kind'> = {},
): CursorHarnessDescriptor => ({
  kind: 'cursor',
  ...options,
})

const STEP_KEYS = ['exec', 'write', 'reply']

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
        : typeof value === 'string')
    if (!valid) {
      throw new UsageError(
        `fakeHarness({ script }) steps are { exec: string }, { write: { path: content } } or { reply: string } (got ${JSON.stringify(step)})`,
      )
    }
  }
}

/** A fake agent that writes canned files and replies with canned text. For tests and dry runs. */
export const fakeHarness = (options: Omit<FakeHarnessDescriptor, 'kind'> = {}) => {
  if (options.script !== undefined) checkScript(options.script)
  return { kind: 'fake', ...options } satisfies FakeHarnessDescriptor
}

export type {
  CursorHarnessDescriptor,
  FakeHarnessDescriptor,
  FakeScriptStep,
  HarnessDescriptor,
} from './types.ts'
