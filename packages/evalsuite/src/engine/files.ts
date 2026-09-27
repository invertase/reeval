// Which files are eval files, and which of them a path filter picks, as Vitest decided both.
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { glob } from 'tinyglobby'
import { attemptId, relativeFile } from '../ids.ts'

/** Never searched for eval files. */
export const DEFAULT_EXCLUDE = ['**/node_modules/**', '**/.git/**']

/** Every file under `root` matching `include` and none of `exclude`, as absolute paths, sorted. */
export async function findEvalFiles(
  root: string,
  include: readonly string[],
  exclude: readonly string[],
): Promise<string[]> {
  const files = await glob([...include], {
    cwd: root,
    dot: true,
    ignore: [...exclude],
    expandDirectories: false,
  })
  return files.map((file) => resolve(root, file)).sort()
}

/**
 * The files a filter part picks: those whose path relative to `root` contains it, ignoring case,
 * or contains it resolved from the current directory; an absolute path picks what's under it.
 */
export function filterFiles(files: readonly string[], filters: readonly string[], root: string) {
  if (filters.length === 0) return [...files]
  // Compared with forward slashes, so `evals/a` picks `evals\a.es.ts` on Windows, as does `evals\a`.
  const slashed = (path: string) => (sep === '\\' ? path.replaceAll('\\', '/') : path)
  return files.filter((file) => {
    const rel = relativeFile(root, file).toLocaleLowerCase()
    return filters.some((f) => {
      if (isAbsolute(f) && isUnder(file, resolve(f))) return true
      const typed = slashed(f)
      const fromCwd = relativeFile(root, f) + (typed.endsWith('/') ? '/' : '')
      return rel.includes(typed.toLocaleLowerCase()) || rel.includes(fromCwd.toLocaleLowerCase())
    })
  })
}

/** Whether `file` is `dir` or under it; any case on Windows, where paths ignore it. */
function isUnder(file: string, dir: string): boolean {
  const rel = relative(dir, file)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** A name or cell filter part matches part of the eval id (`file › group › name`) or `cell#n`. */
export const matchesFilter = (
  e: { id: string; attempt?: { cell: { key: string }; n: number } | undefined },
  filter: string,
): boolean =>
  e.id.includes(filter) ||
  (!!e.attempt && attemptId(e.attempt.cell.key, e.attempt.n).includes(filter))
