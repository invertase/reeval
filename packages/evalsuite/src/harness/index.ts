import type { HarnessDescriptor } from '../types.ts'
import { agentOf, type Layout } from './agents.ts'
import { createFakeHarness } from './fake.ts'
import type { Harness } from './types.ts'

export async function createHarness(descriptor: HarnessDescriptor): Promise<Harness> {
  if (descriptor.kind === 'fake') return createFakeHarness(descriptor)
  const { createAgentHarness } = await import('./agent.ts')
  return createAgentHarness(descriptor)
}

/** The fake agent's own layout. */
const FAKE_LAYOUT: Layout = { rulesFile: 'AGENTS.md', workspaceSkillDir: '.agents/skills' }

/** Where a harness's agent reads rules and repo skills. */
export const layoutOf = (descriptor: HarnessDescriptor): Layout =>
  agentOf(descriptor) ?? FAKE_LAYOUT

/** Where each harness's agent looks for repo skills, relative to the workspace. */
export const workspaceSkillDir = (descriptor: HarnessDescriptor): string =>
  layoutOf(descriptor).workspaceSkillDir

export type { Harness }
