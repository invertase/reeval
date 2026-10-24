// `reeval/testing`: helpers for fixture evals. Not the authoring API.
import { type RecordCall, recordCall } from './attempt/match.ts'
import { attemptRecordings } from './engine/runtime.ts'
import type { AssertionRecord } from './types.ts'

export type { FakeInstructionStep, FakeInstructions } from './capture/fake-instructions.ts'
export { fakeInstructions } from './capture/fake-instructions.ts'
export type { DeclarationTree, DeclaredNode } from './declaration.ts'
export { declareTree } from './evaluate.ts'
export type { CaptureUseAction, Wait } from './types.ts'

/** The attempt protocol's `record` call on the running attempt, as a remote runner makes it. */
export const recordCheck = (call: Omit<RecordCall, 'op'>): AssertionRecord =>
  recordCall(attemptRecordings(), { op: 'record', ...call })
