// Test-only journey script. `fakeInstructions` brands an instructions array;
// `c.capture` reads the brand. Authors still write `string | { wait }`.

import type { CaptureInstruction, CaptureUseAction, Wait } from '../types.ts'

export const FAKE_INSTRUCTIONS = Symbol.for('reeval.capture.fakeInstructions')

export type FakeInstructionStep = CaptureUseAction[] | { wait: Wait }

export type FakeInstructions = CaptureInstruction[] & {
  readonly [FAKE_INSTRUCTIONS]: readonly FakeInstructionStep[]
}

export function isWaitStep(step: unknown): step is { wait: Wait } {
  return typeof step === 'object' && step !== null && !Array.isArray(step) && 'wait' in step
}

/** One list: action lists and `{ wait }` inlined. Returns branded `instructions`. */
export function fakeInstructions(steps: readonly FakeInstructionStep[]): FakeInstructions {
  if (!Array.isArray(steps)) {
    throw new Error(
      `fakeInstructions() is an array of action lists and { wait } (got ${JSON.stringify(steps)})`,
    )
  }
  const instructions: CaptureInstruction[] = []
  let goals = 0
  for (const [i, step] of steps.entries()) {
    if (isWaitStep(step)) {
      instructions.push({ wait: step.wait })
      continue
    }
    if (!Array.isArray(step)) {
      throw new Error(
        `fakeInstructions()[${i}] is an action list or { wait } (got ${JSON.stringify(step)})`,
      )
    }
    instructions.push(`fake[${goals}]`)
    goals++
  }
  Object.defineProperty(instructions, FAKE_INSTRUCTIONS, {
    value: steps,
    enumerable: false,
  })
  return instructions as FakeInstructions
}

export function fakeInstructionSteps(value: unknown): readonly FakeInstructionStep[] | undefined {
  if (typeof value === 'object' && value !== null && FAKE_INSTRUCTIONS in value) {
    return (value as FakeInstructions)[FAKE_INSTRUCTIONS]
  }
}
