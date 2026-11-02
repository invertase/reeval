import type { VertexSettings } from '../gateway/vertex.ts'
import type { HarnessDescriptor, SandboxDescriptor } from '../types.ts'
import { layoutOf } from './agents.ts'
import { createFakeHarness } from './fake.ts'
import type { Harness } from './types.ts'

/** The attempt's harness, for the sandbox it runs in; an agent the sandbox can't run is an infra error. */
export async function createHarness(
  descriptor: HarnessDescriptor,
  sandbox: SandboxDescriptor,
  vertex?: VertexSettings,
): Promise<Harness> {
  if (descriptor.kind === 'fake') return createFakeHarness(descriptor)
  const { createAgentHarness } = await import('./agent.ts')
  return createAgentHarness(descriptor, sandbox, vertex)
}

/** Where each harness's agent looks for repo skills, relative to the workspace. */
export const workspaceSkillDir = (descriptor: HarnessDescriptor): string =>
  layoutOf(descriptor).workspaceSkillDir

export type { Harness }
export { layoutOf }
