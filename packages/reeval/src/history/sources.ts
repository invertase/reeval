// What an eval measures depends on its file and on the local code it imports (helpers, shared
// environments), so fingerprints hash all of it. Packages are covered by the recorded lockfiles.
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { sha256 } from '../ids.ts'

export type Source = { path: string; sha256: string }

/** `from '…'`, `import '…'`, `import('…')` and `export … from '…'`, with a literal specifier. */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])((?:\.{1,2}\/|\/)[^'"]+)\1/g

const CANDIDATES = (path: string) => {
  const js = /\.(m?js|cjs)$/.exec(path)
  return [
    path,
    ...(js ? [path.replace(/\.(m?js|cjs)$/, '.ts'), path.replace(/\.(m?js|cjs)$/, '.tsx')] : []),
    `${path}.ts`,
    `${path}.tsx`,
    `${path}.js`,
    `${path}.mjs`,
    join(path, 'index.ts'),
    join(path, 'index.js'),
  ]
}

async function isFile(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isFile() ?? false
}

async function resolveImport(from: string, specifier: string): Promise<string | null> {
  const base = specifier.startsWith('/') ? specifier : resolve(dirname(from), specifier)
  for (const candidate of CANDIDATES(base)) if (await isFile(candidate)) return candidate
  return null
}

/**
 * The eval file and every local module it imports, transitively, by path from `root` and
 * content hash, sorted by path. Only relative and absolute specifiers are followed: packages
 * (`evalsuite`, `node:*`, anything in `node_modules`) aren't traced.
 */
export async function traceSources(root: string, file: string): Promise<Source[]> {
  const seen = new Map<string, Source>()
  const queue = [resolve(root, file)]
  while (queue.length) {
    const path = queue.shift() as string
    if (seen.has(path) || path.split(sep).includes('node_modules')) continue
    const bytes = await readFile(path).catch(() => null)
    if (!bytes) continue
    seen.set(path, { path: relative(root, path).split(sep).join('/'), sha256: sha256(bytes) })
    for (const match of bytes.toString('utf8').matchAll(SPECIFIER)) {
      const found = await resolveImport(path, match[2] as string)
      if (found && !seen.has(found)) queue.push(found)
    }
  }
  return [...seen.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}
