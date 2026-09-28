/** Installed dependencies: one entry per directory, never one per file. */
const DEPENDENCY_DIR = /^(.*?(?:^|\/)(?:node_modules|\.venv|\.dart_tool|\.pub-cache|__pycache__)\/)/
const LOCKFILE = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/

export const isNoisePath = (path: string) => DEPENDENCY_DIR.test(path) || LOCKFILE.test(path)

export type Collapsed<T> = { kept: T[]; dirs: Array<{ dir: string; count: number }> }

/** Replaces every file under a dependency directory with one `{ dir, count }` entry. */
export function collapseDependencies<T>(items: T[], pathOf: (item: T) => string): Collapsed<T> {
  const kept: T[] = []
  const counts = new Map<string, number>()
  for (const item of items) {
    const dir = DEPENDENCY_DIR.exec(pathOf(item))?.[1]
    if (dir) counts.set(dir, (counts.get(dir) ?? 0) + 1)
    else kept.push(item)
  }
  return { kept, dirs: [...counts].map(([dir, count]) => ({ dir, count })) }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

const changedLines = (part: string) =>
  part.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l)).length

/**
 * Diff text the judge can actually grade. Source files are kept whole; each dropped file is
 * replaced by a marker naming it, and a dependency directory by one marker with its file count.
 * `git apply` skips the marker lines.
 */
export function patchForJudge(patch: string): string {
  if (!patch) return patch
  const parts = patch.split(/(?=^diff --git )/m).filter((part) => part.length > 0)
  const paths = parts.map(diffPath)
  const dirCounts = new Map<string, number>()
  for (const path of paths) {
    const dir = path ? DEPENDENCY_DIR.exec(path)?.[1] : undefined
    if (dir) dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1)
  }
  const out: string[] = []
  const marked = new Set<string>()
  for (const [i, part] of parts.entries()) {
    const path = paths[i]
    if (!path) {
      out.push(part)
      continue
    }
    const dir = DEPENDENCY_DIR.exec(path)?.[1]
    if (dir) {
      if (!marked.has(dir)) {
        marked.add(dir)
        out.push(
          `[es: dropped ${dir} (${plural(dirCounts.get(dir) ?? 0, 'file')}): installed dependencies]\n`,
        )
      }
    } else if (LOCKFILE.test(path)) {
      out.push(`[es: dropped ${path}: lockfile, ${plural(changedLines(part), 'changed line')}]\n`)
    } else if (part.includes('\nGIT binary patch\n')) {
      out.push(`[es: dropped ${path}: binary]\n`)
    } else {
      out.push(part)
    }
  }
  return out.join('')
}

/** `status path` lines for the judge, with dependency directories collapsed. */
export function changedFilesForJudge(files: Array<{ path: string; status: string }>): string[] {
  const { kept, dirs } = collapseDependencies(files, (f) => f.path)
  return [
    ...kept.map((f) => `${f.status} ${f.path}`),
    ...dirs.map((d) => `changed ${d.dir} (${plural(d.count, 'file')})`),
  ]
}

function diffPath(part: string): string | null {
  const header = /^(?:diff --git a\/.+ b\/(.+))$/m.exec(part)
  return header?.[1] ?? null
}
