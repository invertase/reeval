import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { git, repoTop } from '../git.ts'
import { fromCwd, relativeFile } from '../ids.ts'

/**
 * Un-ignores recorded artifacts. A parent `*.log` would otherwise drop `setup.log` and
 * `checks/<n>.log` when someone `git add`s the history folder. Ignores the `.tmp-*` files a
 * write keeps there while it runs, such as a claim a crashed write left.
 */
export const HISTORY_GITIGNORE = `# Un-ignore recorded files. A parent *.log drops setup.log and checks/*.log.
!*.json
!*.jsonl
!*.md
!*.patch
!*.log
# A write in progress, or one cut short: never part of history.
.tmp-*
`

/** Marks recorded runs generated, so GitHub collapses them in a pull request's diff. */
export const HISTORY_GITATTRIBUTES = '* linguist-generated=true\n'

export const historyGitignorePath = (historyDir: string) => join(historyDir, '.gitignore')

export const historyGitattributesPath = (historyDir: string) => join(historyDir, '.gitattributes')

async function ensureFile(historyDir: string, path: string, content: string): Promise<string> {
  try {
    await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await mkdir(historyDir, { recursive: true })
    await writeFile(path, content)
  }
  return path
}

/** Writes the history-folder `.gitignore` when it's missing; leaves a file that's already there. */
export const ensureHistoryGitignore = (historyDir: string): Promise<string> =>
  ensureFile(historyDir, historyGitignorePath(historyDir), HISTORY_GITIGNORE)

/** Writes the history-folder `.gitattributes` when it's missing; leaves a file that's already there. */
export const ensureHistoryGitattributes = (historyDir: string): Promise<string> =>
  ensureFile(historyDir, historyGitattributesPath(historyDir), HISTORY_GITATTRIBUTES)

export type IgnoredRecorded = { path: string; rule: string; source: string }

/** `git check-ignore -v` one line: `<source>:<line>:<pattern><TAB><pathname>`. */
export function parseCheckIgnore(line: string): IgnoredRecorded | null {
  const tab = line.indexOf('\t')
  if (tab < 0) return null
  const meta = line.slice(0, tab)
  const pathname = line.slice(tab + 1)
  const match = meta.match(/^(.*):(\d+):(.*)$/)
  if (!match) return null
  const [, source, lineNo, rule] = match
  if (!source || !rule) return null
  // `-v` prints the last matching pattern even when it's a `!` un-ignore; those are not ignored.
  if (rule.startsWith('!')) return null
  return { path: pathname, rule, source: `${source}:${lineNo}` }
}

/**
 * Files among `files` that git would ignore (so `git add` of the history folder would drop them).
 * Empty when this isn't a git repo or git can't tell.
 */
export async function ignoredRecordedFiles(
  root: string,
  files: string[],
): Promise<IgnoredRecorded[]> {
  if (files.length === 0) return []
  const top = await repoTop(root)
  if (!top) return []
  const r = await git(top, ['check-ignore', '-v', '--no-index', '--stdin'], {
    input: `${files.map((f) => relativeFile(top, f)).join('\n')}\n`,
  })
  if (r.code !== 0) return []
  return r.stdout
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      const parsed = parseCheckIgnore(line)
      if (!parsed) return []
      const abs = isAbsolute(parsed.path) ? parsed.path : join(top, parsed.path)
      return [{ ...parsed, path: fromCwd(abs) }]
    })
}
