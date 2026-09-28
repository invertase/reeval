// `reeval report --issue`: a pre-filled new-issue URL for reeval's repository, from the package's `bugs`
// field, or `gh issue create` when gh is installed and the user confirms. Nothing leaves the
// machine without one of those two steps.
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { run } from '@reeval/sandbox-docker/process'
import { PACKAGE_DIR } from '../root.ts'

/** GitHub refuses longer new-issue URLs; this leaves room under its ~8 KB limit. */
export const MAX_URL = 8000
/** GitHub's limit on an issue body is 65536 characters. */
export const MAX_BODY = 60_000
/** The issue form in `.github/ISSUE_TEMPLATE/`, and the ids of the fields reeval fills. */
export const ISSUE_TEMPLATE = 'bug_report.yml'
export const FIELDS = { report: 'report', whatHappened: 'what-happened' } as const

const TRUNCATED = '\n\n…cut to fit the URL: attach report.md for the rest.'

export type IssueRepo = { issues: string; slug: string | null }

/** The issues page from `bugs` in reeval's package.json, so a rename moves it too. */
export function issueRepo(
  pkg: { bugs?: string | { url?: string } } = JSON.parse(
    readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'),
  ),
): IssueRepo {
  const url = (typeof pkg.bugs === 'string' ? pkg.bugs : pkg.bugs?.url)?.replace(/\/+$/, '')
  if (!url) throw new Error("reeval's package.json has no bugs URL")
  const slug = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues$/.exec(url)?.[1] ?? null
  return { issues: url, slug }
}

function build(repo: IssueRepo, title: string, whatHappened: string, report: string): string {
  const params = new URLSearchParams({
    template: ISSUE_TEMPLATE,
    title,
    [FIELDS.whatHappened]: whatHappened,
    [FIELDS.report]: report,
  })
  return `${repo.issues}/new?${params.toString().replaceAll('+', '%20')}`
}

/**
 * The new-issue URL with the form's fields filled, at most `max` characters: the report field is
 * cut at a line (and says so) until it fits.
 */
export function issueUrl(
  repo: IssueRepo,
  title: string,
  report: string,
  whatHappened = '',
  max = MAX_URL,
): string {
  const full = build(repo, title, whatHappened, report)
  if (full.length <= max) return full
  let lo = 0
  let hi = report.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (build(repo, title, whatHappened, report.slice(0, mid) + TRUNCATED).length <= max) lo = mid
    else hi = mid - 1
  }
  const cut = report.slice(0, lo)
  const atLine = cut.lastIndexOf('\n')
  const kept = atLine > cut.length / 2 ? cut.slice(0, atLine) : cut
  const url = build(repo, title, whatHappened, kept + TRUNCATED)
  if (url.length > max) throw new Error('The issue title alone is too long for a URL')
  return url
}

export type IssueDeps = {
  /** Whether `gh` is on the PATH. */
  hasGh: () => Promise<boolean>
  /** Runs gh; returns its exit code and output. */
  gh: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>
  /** Opens a URL in the browser; false when it couldn't. */
  open: (url: string) => Promise<boolean>
}

const exec = (command: string, args: string[]) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(command, args, { timeout: 60_000 }, (error, stdout, stderr) =>
      resolve({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout: String(stdout),
        stderr: String(stderr),
      }),
    )
  })

/** gh through reeval's own `run`, which finds it however it's installed on Windows (.exe or .cmd). */
const gh = (args: string[]) =>
  run('gh', args, { signal: AbortSignal.timeout(60_000), detached: false }).then(
    (r) => ({ code: r.exitCode, stdout: r.stdout, stderr: r.stderr }),
    (error: Error) => ({ code: 1, stdout: '', stderr: error.message }),
  )

export function defaultIssueDeps(): IssueDeps {
  return {
    hasGh: async () => (await gh(['--version'])).code === 0,
    gh,
    open: async (url) => {
      const [command, args] =
        process.platform === 'darwin'
          ? ['open', [url]]
          : process.platform === 'win32'
            ? ['cmd', ['/c', 'start', '""', url.replaceAll('&', '^&')]]
            : ['xdg-open', [url]]
      return (await exec(command as string, args as string[])).code === 0
    },
  }
}

export type FileIssue = {
  repo: IssueRepo
  title: string
  body: string
  /** Where the body is on disk, for `gh --body-file`. */
  bodyFile: string
  whatHappened: string
  /** Asks yes/no in a terminal; undefined when there's none. */
  confirm?: (question: string) => Promise<boolean>
  yes: boolean
  interactive: boolean
  out: (line: string) => void
}

/** Files it with gh when gh is there and the user says yes (or `-y`); else the URL. */
export async function fileIssue(o: FileIssue, deps: IssueDeps): Promise<'gh' | 'url'> {
  if (o.repo.slug && (await deps.hasGh())) {
    const ok =
      o.yes ||
      (!!o.confirm &&
        (await o.confirm(`File this as an issue on ${o.repo.slug} with gh issue create? [y/N] `)))
    if (ok) {
      const r = await deps.gh([
        'issue',
        'create',
        '--repo',
        o.repo.slug,
        '--title',
        o.title,
        '--body-file',
        o.bodyFile,
      ])
      if (r.code === 0) {
        o.out(`Filed ${r.stdout.trim()}`)
        return 'gh'
      }
      o.out(`gh issue create failed (${r.stderr.trim() || `exit ${r.code}`}); use the URL instead.`)
    }
  }
  const url = issueUrl(o.repo, o.title, o.body, o.whatHappened)
  o.out('Open this to file the issue (pre-filled; nothing is sent until you submit it):')
  o.out(url)
  if (o.interactive) await deps.open(url)
  return 'url'
}
