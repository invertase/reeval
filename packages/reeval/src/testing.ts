// `reeval/testing`: helpers for fixture evals. Not the authoring API.

export type { FakeInstructionStep, FakeInstructions } from './capture/fake-instructions.ts'
export { fakeInstructions } from './capture/fake-instructions.ts'
export type { DeclarationTree, DeclaredNode } from './declaration.ts'
export { declareTree } from './evaluate.ts'

import type { FakeGatewayDescriptor } from './types.ts'

export type { CaptureUseAction, FakeGatewayDescriptor, Wait } from './types.ts'

/**
 * A gateway for tests that serves only `serves` (default `['fake']`), so a `gateway` list's
 * fallback and pins can be planned without a credential. Nothing changes inside an attempt.
 */
export const fakeGateway = (
  options: Omit<FakeGatewayDescriptor, 'kind'> = {},
): FakeGatewayDescriptor => ({ kind: 'fake', ...options })
