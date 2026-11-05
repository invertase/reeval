// `reeval/store/local`: the history kept in a folder of the project, which is the default.
import { UsageError } from './errors.ts'
import type { LocalStoreDescriptor } from './types.ts'

export type { LocalStoreDescriptor } from './types.ts'

/**
 * Recorded runs in a folder, relative to the config's directory (`dir`, by default
 * `<evals>/.history`), committed to git with the code they ran.
 */
export function local(options: Omit<LocalStoreDescriptor, 'kind'> = {}): LocalStoreDescriptor {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new UsageError(
      `local() takes an options object like { dir: 'history' } (got ${JSON.stringify(options)})`,
    )
  }
  return { ...options, kind: 'local' }
}
