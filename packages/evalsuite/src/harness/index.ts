import type { HarnessDescriptor } from '../types.ts'
import { createFakeHarness } from './fake.ts'
import type { Harness } from './types.ts'

export async function createHarness(descriptor: HarnessDescriptor): Promise<Harness> {
  switch (descriptor.kind) {
    case 'fake':
      return createFakeHarness(descriptor)
    case 'cursor': {
      const { createCursorHarness } = await import('./cursor.ts')
      return createCursorHarness(descriptor)
    }
  }
}

/** Where each harness's agent looks for repo skills, relative to the workspace. */
export const workspaceSkillDir = (descriptor: HarnessDescriptor): string =>
  descriptor.kind === 'cursor' ? '.cursor/skills' : '.agents/skills'

export type { Harness }
