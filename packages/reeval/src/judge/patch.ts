import { globFilter } from '../environment.ts'
import { plural } from '../text.ts'
import { patchPath } from '../view/patch.ts'

/** Installed dependencies: one entry per directory, never one per file. */
const DEPENDENCY_DIR = /^(.*?(?:^|\/)(?:node_modules|\.venv|\.dart_tool|\.pub-cache|__pycache__)\/)/
/**
 * Build output: `dist/` and `.next/` at any depth; `build/` and `out/` at the top of the
 * workspace only, since a nested one can be source.
 */
const BUILD_DIR = /^((?:.*?\/)?(?:dist|\.next)\/|(?:build|out)\/)/
const LOCKFILE = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/
const GENERATED = /\.(?:map|tsbuildinfo)$/
/** A changed line this long is a minified bundle or generated data, not code anyone wrote. */
export const MINIFIED_LINE_CHARS = 1000

export type Collapsed<T> = { kept: T[]; dirs: Array<{ dir: string; count: number }> }

/** Replaces every file under a dependency directory with one `{ dir, count }` entry. */
export function collapseDependencies<T>(items: T[], pathOf: (item: T) => string): Collapsed<T> {
  return collapse(items, pathOf, DEPENDENCY_DIR)
}

function collapse<T>(items: T[], pathOf: (item: T) => string, dirOf: RegExp): Collapsed<T> {
  const kept: T[] = []
  const counts = new Map<string, number>()
  for (const item of items) {
    const dir = dirOf.exec(pathOf(item))?.[1]
    if (dir) counts.set(dir, (counts.get(dir) ?? 0) + 1)
    else kept.push(item)
  }
  return { kept, dirs: [...counts].map(([dir, count]) => ({ dir, count })) }
}

const changedLineList = (part: string) =>
  part.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l))

/** What the judge sees of the workspace's changes, and what was left out of it. */
export type JudgeDiff = {
  /** `status path` lines, with dependency and build directories collapsed. */
  files: string[]
  /** The diff, each dropped file or directory replaced by a `[reeval: dropped …]` marker. */
  patch: string
  /** What was left out and why, e.g. `dist/ (3 files): build output`. */
  dropped: string[]
}

export type JudgeDiffOptions = {
  /** Gitignore-style patterns over workspace paths; the last match wins and `!` excludes. */
  patterns?: readonly string[]
  /** Paths shown in full elsewhere in the judge's state: left out of the diff. */
  inFull?: ReadonlySet<string>
}

/**
 * The diff text and changed files the judge can actually grade. Source files are kept whole;
 * dependencies, build output, lockfiles, binaries, source maps, build info and minified files are
 * each replaced by a marker naming them (a directory by one marker with its file count), and paths
 * `patterns` (`diff`'s) leave out are gone. `git apply` skips the marker lines.
 */
export function judgeDiff(
  diff: { patch: string; files: Array<{ path: string; status: string }> },
  { patterns, inFull }: JudgeDiffOptions = {},
): JudgeDiff {
  const included = patterns?.length ? globFilter(patterns) : () => true
  const dropped: string[] = []
  const files = diff.files.filter((f) => included(f.path))
  for (const f of diff.files)
    if (!included(f.path)) dropped.push(`${f.path}: not in diff's patterns`)
  const deps = collapse(files, (f) => f.path, DEPENDENCY_DIR)
  const built = collapse(deps.kept, (f) => f.path, BUILD_DIR)
  const fileLines = [
    ...built.kept.map((f) => `${f.status} ${f.path}`),
    ...[...deps.dirs, ...built.dirs].map((d) => `changed ${d.dir} (${plural(d.count, 'file')})`),
  ]
  if (!diff.patch) return { files: fileLines, patch: diff.patch, dropped }
  const parts = diff.patch.split(/(?=^diff --git )/m).filter((part) => part.length > 0)
  const paths = parts.map(patchPath)
  const dirCounts = new Map<string, number>()
  const dirOf = (path: string) => DEPENDENCY_DIR.exec(path)?.[1] ?? BUILD_DIR.exec(path)?.[1]
  for (const path of paths) {
    const dir = path && included(path) ? dirOf(path) : undefined
    if (dir) dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1)
  }
  const out: string[] = []
  const marked = new Set<string>()
  const drop = (what: string) => {
    dropped.push(what)
    out.push(`[reeval: dropped ${what}]\n`)
  }
  for (const [i, part] of parts.entries()) {
    const path = paths[i]
    if (!path) {
      out.push(part)
      continue
    }
    if (!included(path) || inFull?.has(path)) continue
    const dir = dirOf(path)
    if (dir) {
      if (marked.has(dir)) continue
      marked.add(dir)
      const why = DEPENDENCY_DIR.test(path) ? 'installed dependencies' : 'build output'
      drop(`${dir} (${plural(dirCounts.get(dir) ?? 0, 'file')}): ${why}`)
      continue
    }
    if (LOCKFILE.test(path)) {
      drop(`${path}: lockfile, ${plural(changedLineList(part).length, 'changed line')}`)
      continue
    }
    if (part.includes('\nGIT binary patch\n')) {
      drop(`${path}: binary`)
      continue
    }
    if (GENERATED.test(path)) {
      drop(`${path}: generated`)
      continue
    }
    const longest = Math.max(0, ...changedLineList(part).map((l) => l.length - 1))
    if (longest > MINIFIED_LINE_CHARS) {
      drop(`${path}: minified, a line of ${longest} characters`)
      continue
    }
    out.push(part)
  }
  return { files: fileLines, patch: out.join(''), dropped }
}

/** `judgeDiff`'s diff text alone, for a patch without its file list. */
export const patchForJudge = (patch: string): string => judgeDiff({ patch, files: [] }).patch

/** `status path` lines for the judge, with dependency and build directories collapsed. */
export const changedFilesForJudge = (files: Array<{ path: string; status: string }>): string[] =>
  judgeDiff({ patch: '', files }).files
