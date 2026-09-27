// Which files are eval files, and which of them a path filter picks, as Vitest decided both.
import { isAbsolute, join, relative, resolve } from 'node:path'
import { glob } from 'tinyglobby'
import { attemptId } from '../ids.ts'

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
  return files.filter((file) => {
    const rel = relative(root, file).toLocaleLowerCase()
    return filters.some((f) => {
      if (isAbsolute(f) && file.startsWith(f)) return true
      const fromCwd = f.endsWith('/') ? join(relative(root, f), '/') : relative(root, f)
      return rel.includes(f.toLocaleLowerCase()) || rel.includes(fromCwd.toLocaleLowerCase())
    })
  })
}

/** A name or cell filter part matches part of the eval id (`file › group › name`) or `cell#n`. */
export const matchesFilter = (
  e: { id: string; attempt?: { cell: { key: string }; n: number } | undefined },
  filter: string,
): boolean =>
  e.id.includes(filter) ||
  (!!e.attempt && attemptId(e.attempt.cell.key, e.attempt.n).includes(filter))
