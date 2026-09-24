/** Installed dependencies: one entry per directory, never one per file. */
const DEPENDENCY_DIR = /^(.*?(?:^|\/)(?:node_modules|\.venv|\.dart_tool|\.pub-cache|__pycache__)\/)/
const LOCKFILE = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/
const MAX_NAMES = 50

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

/** Diff text the judge can actually grade. Source files are kept whole. */
export function patchForJudge(patch: string): string {
  if (!patch) return patch
  const parts = patch.split(/(?=^diff --git )/m).filter((part) => part.length > 0)
  const kept: string[] = []
  const omitted: string[] = []
  for (const part of parts) {
    const path = diffPath(part)
    if (path && (isNoisePath(path) || part.includes('\nGIT binary patch\n'))) {
      omitted.push(path)
      continue
    }
    kept.push(part)
  }
  const body = kept.join('')
  if (omitted.length === 0) return body
  const { kept: files, dirs } = collapseDependencies(omitted, (p) => p)
  const names = [
    ...dirs.map((d) => `- ${d.dir} (${plural(d.count, 'file')})`),
    ...files.slice(0, MAX_NAMES).map((path) => `- ${path}`),
    ...(files.length > MAX_NAMES ? [`- … and ${files.length - MAX_NAMES} more`] : []),
  ].join('\n')
  return `${body}${body.endsWith('\n') || body.length === 0 ? '' : '\n'}[omitted ${plural(omitted.length, 'dependency or binary file')} from the judge prompt]\n${names}\n`
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
