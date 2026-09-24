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

export type { Harness }
