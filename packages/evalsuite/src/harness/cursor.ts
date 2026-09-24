import { InfraError } from '../sandbox/types.ts'
import type { CursorHarnessDescriptor } from '../types.ts'
import type { Harness } from './types.ts'

export function createCursorHarness(_descriptor: CursorHarnessDescriptor): Harness {
  throw new InfraError('The Cursor harness is not implemented yet')
}
