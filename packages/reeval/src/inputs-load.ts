// The host files a load reads: an eval file's in its worker, the config's in the CLI. While it
// runs, `fs`'s read calls are wrapped (and Node's ESM view of them synced), so jiti's reads of the
// modules it imports and user code's own reads are both seen. Only `readFile`-style calls of a
// file that exists count: a stat, a directory listing or a read through a descriptor isn't seen.
import fs, { statSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformedFiles } from './jiti.ts'
import { ownReads } from './own-reads.ts'
import { PACKAGE_DIR } from './root.ts'
import type { LocalInput } from './types.ts'

/** The path a read call names, or undefined for a descriptor or anything else. */
function pathOf(arg: unknown): string | undefined {
  if (typeof arg === 'string') return resolve(arg)
  if (arg instanceof URL) return arg.protocol === 'file:' ? fileURLToPath(arg) : undefined
  if (Buffer.isBuffer(arg)) return resolve(arg.toString('utf8'))
  return undefined
}

/** Reads that aren't the project's: dependencies, reeval itself, its own state, the OS's. */
function ignored(path: string, root: string): boolean {
  const parts = path.split(sep)
  if (parts.includes('node_modules') || parts.includes('.git')) return true
  if (path.startsWith(join(root, '.reeval') + sep)) return true
  if (path.startsWith(PACKAGE_DIR)) return true
  return ['/proc/', '/sys/', '/dev/'].some((p) => path.startsWith(p))
}

const TSCONFIG = /^(?:tsconfig|jsconfig)(?:\.[\w.-]+)?\.json$/

/** A file in jiti's fs cache (`<tmp>/jiti/`), which it reads right after the module's source. */
const jitiCached = (path: string) =>
  basename(dirname(path)) === 'jiti' && /\.[0-9a-f]{8}\.[cm]?js$/.test(path)

/**
 * Starts recording the host files read until `stop`, which restores `fs` and returns them,
 * classified: a module jiti transformed, read from its cache or Node's require cache holds is a
 * `module`, a tsconfig a `tsconfig`, a `.env` file an `env-file`, and anything else a `read`.
 * `main`, the file the load is for, comes first as `mainKind`. What reeval reads for itself
 * (`asOwnReads`) isn't recorded. A plain CommonJS module jiti loads
 * without its module cache (the config's) isn't transformed, so it counts as a `read`.
 */
export function trackLoad(root: string) {
  const reads = new Set<string>()
  const cached = new Set<string>()
  let last: string | undefined
  const record = (arg: unknown) => {
    if (ownReads.depth > 0) return
    const path = pathOf(arg)
    if (!path || !isAbsolute(path)) return
    if (jitiCached(path)) {
      if (last) cached.add(last)
    } else if (!ignored(path, root)) {
      reads.add(path)
      last = path
    }
  }
  const sync = fs.readFileSync
  const callback = fs.readFile
  const promised = fs.promises.readFile
  const wrap = <F extends (...args: never[]) => unknown>(original: F): F =>
    function (this: unknown, ...args: Parameters<F>) {
      record(args[0])
      return original.apply(this, args)
    } as F
  fs.readFileSync = wrap(sync)
  fs.readFile = wrap(callback) as typeof fs.readFile
  fs.promises.readFile = wrap(promised)
  syncBuiltinESMExports()
  const required = new Set(Object.keys(createRequire(join(root, 'x')).cache))
  const transformed = new Set(transformedFiles)
  return {
    stop(main: string, mainKind: LocalInput['kind']): LocalInput[] {
      fs.readFileSync = sync
      fs.readFile = callback
      fs.promises.readFile = promised
      syncBuiltinESMExports()
      const cache = createRequire(join(root, 'x')).cache
      const modules = new Set([
        ...cached,
        ...[...transformedFiles].filter((f) => !transformed.has(f)),
        ...Object.keys(cache).filter((f) => !required.has(f)),
      ])
      const out: LocalInput[] = [{ path: main, kind: mainKind }]
      for (const path of [...reads].sort()) {
        if (path === main || !statSync(path, { throwIfNoEntry: false })?.isFile()) continue
        const name = basename(path)
        const kind = modules.has(path)
          ? 'module'
          : TSCONFIG.test(name)
            ? 'tsconfig'
            : name === '.env' || name.startsWith('.env.')
              ? 'env-file'
              : 'read'
        out.push({ path, kind })
      }
      return out
    },
  }
}
