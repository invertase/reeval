// `reeval/testing`: helpers for fixture evals. Not the authoring API.
import type { AttemptReply, AttemptRequest } from './contract/attempt.ts'
import { attemptRecordings } from './engine/runtime.ts'
import { replyToAttempt } from './language-runner/attempt-host.ts'
import type { AttemptContext, BackgroundHandle } from './types.ts'

export type { FakeInstructionStep, FakeInstructions } from './capture/fake-instructions.ts'
export { fakeInstructions } from './capture/fake-instructions.ts'
export type { DeclarationTree, DeclaredNode } from './declaration.ts'
export { declareTree } from './evaluate.ts'
export type { CaptureKey, CaptureUseAction, Wait } from './types.ts'

const handles = new WeakMap<AttemptContext, Map<string, BackgroundHandle>>()

/** reeval's reply to an attempt-protocol request on the running attempt, as a remote runner gets it. */
export function attemptReply(c: AttemptContext, request: AttemptRequest): Promise<AttemptReply> {
  const own = handles.get(c) ?? new Map<string, BackgroundHandle>()
  handles.set(c, own)
  return replyToAttempt(c, attemptRecordings(), own, request)
}
