// `es report [run]`: collects a redacted bug report, prints its summary and writes it locally.
// It uploads nothing: `--issue` opens a pre-filled issue, or files one with gh once you say yes.
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir, release } from 'node:os'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { detectAgent } from 'std-env'
import type { Flags } from '../cli-spec.ts'
import { UsageError } from '../config.ts'
import { type Collected, collectReport, type ReportDeps } from './collect.ts'
import { defaultIssueDeps, fileIssue, type IssueDeps, issueRepo, MAX_BODY } from './issue.ts'
import { issueTitle, renderIssueBody, renderMarkdown, summaryLines } from './render.ts'
import { tarGz } from './tar.ts'

export type ReportIO = {
  out: (line: string) => void
  err: (line: string) => void
  /** Whether a person is at a terminal, so `--issue` may open a browser. */
  interactive: boolean
  confirm?: (question: string) => Promise<boolean>
}

export async function defaultReportDeps(): Promise<ReportDeps> {
  const { defaultDeps, doctor } = await import('../doctor.ts')
  const doctorDeps = defaultDeps()
  return {
    env: process.env,
    cwd: process.cwd(),
    home: homedir(),
    platform: process.platform,
    release: release(),
    arch: process.arch,
    nodeVersion: process.versions.node,
    npmVersion: doctorDeps.npmVersion,
    doctor: async (flags) => (await doctor(flags, doctorDeps)).report,
    agent: detectAgent().name ?? null,
    now: () => new Date(),
  }
}

export type Written = { dir: string; markdown: string; json: string; logs: string | null }

const stamp = (date: Date) =>
  date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')

/**
 * Writes report.md, report.json and (with logs) report-logs.tar.gz. `out` is a directory, or a
 * `.md` or `.json` file that the others are written beside.
 */
export function writeReport(collected: Collected, out: string, attached: string[]): Written {
  const ext = extname(out).toLowerCase()
  const asFile = ext === '.md' || ext === '.json'
  const dir = asFile ? dirname(out) : out
  const base = asFile ? basename(out, extname(out)) : 'report'
  mkdirSync(dir, { recursive: true })
  const markdown = join(dir, `${base}.md`)
  const json = join(dir, `${base}.json`)
  writeFileSync(markdown, renderMarkdown(collected.bundle, attached))
  writeFileSync(json, `${JSON.stringify(collected.bundle, null, 2)}\n`)
  let logs: string | null = null
  if (collected.attachments.length) {
    logs = join(dir, `${base}-logs.tar.gz`)
    writeFileSync(logs, tarGz(collected.attachments))
  }
  return { dir, markdown, json, logs }
}

export async function reportCommand(
  flags: Flags,
  refs: string[],
  io: ReportIO,
  deps?: ReportDeps,
  issueDeps: IssueDeps = defaultIssueDeps(),
): Promise<number> {
  if (flags.json && flags.issue) {
    throw new UsageError('es report --json prints the bundle; --issue files it. Pick one.')
  }
  const collected = await collectReport(flags, refs, deps ?? (await defaultReportDeps()))
  const { bundle, attachments, root } = collected
  const attached = attachments.map((a) => a.path)
  if (flags.json) {
    io.out(JSON.stringify(bundle, null, 2))
    if (flags.out) {
      const w = writeReport(collected, resolve(flags.out), attached)
      io.err(`Wrote ${files(w)}`)
    }
    return 0
  }
  const target = resolve(
    flags.out ?? join(root, '.es', 'reports', stamp(new Date(bundle.createdAt))),
  )
  const written = writeReport(collected, target, attached)
  io.out('es report')
  for (const line of summaryLines(bundle, attached.length)) io.out(line)
  io.out('')
  io.out(`Wrote ${files(written)}`)
  if (!flags.issue) {
    io.out('Nothing was uploaded. Review the files, then file it with es report --issue.')
    return 0
  }
  const shownDir = collected.scrub.text(written.dir)
  const body = renderIssueBody(bundle, shownDir)
  const bodyFile = join(written.dir, 'issue.md')
  writeFileSync(bodyFile, body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}\n…` : body)
  await fileIssue(
    {
      repo: issueRepo(),
      title: issueTitle(bundle),
      body,
      bodyFile,
      whatHappened: '',
      confirm: io.confirm,
      yes: !!flags.yes,
      interactive: io.interactive,
      out: io.out,
    },
    issueDeps,
  )
  return 0
}

const rel = (path: string) => relative(process.cwd(), path) || path

const files = (w: Written) => [w.markdown, w.json, ...(w.logs ? [w.logs] : [])].map(rel).join(', ')
