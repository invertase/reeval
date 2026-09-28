// jiti as ES uses it, for the config and eval files.
import { dirname, join } from 'node:path'
import { createJiti, type Jiti, type JitiOptions } from 'jiti'
import { COMPILED, ownRequire, PACKAGE_NAMES } from './root.ts'

type Transform = NonNullable<JitiOptions['transform']>

let babel: Transform | undefined

/**
 * jiti's own Babel transform. jiti requires it lazily from beside its code, which a compiled es
 * doesn't have, so ES requires the same file from the jiti package on disk.
 */
export const jitiTransform: Transform = (options) => {
  babel ??= ownRequire(join(dirname(ownRequire.resolve('jiti/package.json')), 'dist/babel.cjs'))
  return (babel as Transform)(options)
}

/**
 * A jiti that imports from `id`. Compiled, a file's imports of ES itself get this es's own
 * modules: a copy on disk would register evals, and hold state, the executable can't see.
 */
export async function esJiti(id: string, options: JitiOptions = {}): Promise<Jiti> {
  const virtualModules = COMPILED ? await ownModules() : undefined
  return createJiti(id, {
    transform: jitiTransform,
    ...options,
    ...(virtualModules && { virtualModules }),
  })
}

async function ownModules(): Promise<Record<string, unknown>> {
  const exports: Record<string, Promise<unknown>> = {
    '': import('./index.ts'),
    '/harness': import('./harness.ts'),
    '/sandbox': import('./sandbox.ts'),
    '/judge': import('./judge.ts'),
    '/view': import('./view/index.ts'),
  }
  const modules: Record<string, unknown> = {}
  for (const [subpath, module] of Object.entries(exports))
    for (const name of PACKAGE_NAMES) modules[name + subpath] = await module
  return modules
}
