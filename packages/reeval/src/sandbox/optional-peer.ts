// An optional peer a user installs for one sandbox (`@boatdev/sdk` for `boat()`, `@daytona/sdk`
// for `daytona()`): only `import()` loads it, where it's used, never the bundle.
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PrepareError } from './provider.ts'

const missing = (error: unknown) =>
  (error as { code?: string }).code === 'ERR_MODULE_NOT_FOUND' ||
  (error as { code?: string }).code === 'MODULE_NOT_FOUND'

/**
 * A loader of the package `name`, from beside reeval or else from the project: a package manager
 * that doesn't link peers into reeval's own `node_modules` still has it in the project's. Without
 * it, a usage error that says `message`. A failed load is tried again next time.
 */
export function optionalPeer<T>(
  name: string,
  o: { stage: string; message: string },
): (projectRoot?: string) => Promise<T> {
  let loaded: Promise<T> | undefined
  return (projectRoot = process.cwd()) => {
    loaded ??= (async () => {
      try {
        return (await import(name)) as T
      } catch (error) {
        if (!missing(error)) throw error
      }
      try {
        const path = createRequire(join(projectRoot, 'noop.js')).resolve(name)
        return (await import(pathToFileURL(path).href)) as T
      } catch (error) {
        if (!missing(error)) throw error
        throw new PrepareError({
          class: 'config',
          stage: o.stage,
          ref: null,
          cause: null,
          log: null,
          usage: true,
          message: o.message,
        })
      }
    })()
    loaded.catch(() => {
      loaded = undefined
    })
    return loaded
  }
}
