import type { HarnessDescriptor } from '../types.ts'
import { layoutOf } from './agents.ts'
import { createFakeHarness } from './fake.ts'
import type { Harness } from './types.ts'

export async function createHarness(descriptor: HarnessDescriptor): Promise<Harness> {
  if (descriptor.kind === 'fake') return createFakeHarness(descriptor)
  const { createAgentHarness } = await import('./agent.ts')
  return createAgentHarness(descriptor)
}

/** Where each harness's agent looks for repo skills, relative to the workspace. */
export const workspaceSkillDir = (descriptor: HarnessDescriptor): string =>
  layoutOf(descriptor).workspaceSkillDir

export type { Harness }
export { layoutOf }
