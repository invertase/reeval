import { runReportMarkdown } from '../renderer/markdown.ts'
import type { Outcome } from '../types.ts'
import { colors } from '../ui/colors.ts'
import { tallyLine } from '../ui/layout.ts'
import { harnessLabel, languageLabel, runtimeLabel } from '../view/model.ts'
import { buildRunReport, type RunReportOptions } from '../view/report/index.ts'
import { runResourcesLine } from '../view/resources.ts'
import { suiteResult } from '../view/suite.ts'
import type { RunRecord } from './types.ts'

export const OUTCOME_MARK: Record<Outcome, string> = {
  pass: '✓',
  fail: '✗',
  infra_error: '!',
  skipped: '↓',
}

/** `5 fail · 2 pass`, with the run's status when it didn't complete. */
export const runTally = (run: RunRecord) =>
  `${tallyLine(colors(false), suiteResult(run).tally)}${run.status === 'complete' ? '' : ` · ${run.status === 'budget' ? 'budget reached' : run.status}`}`

const short = (hash: string) => hash.replace(/^sha256:/, '').slice(0, 12)

/**
 * The state a run executed in, as label/value pairs, shared by `reeval show`.
 * The commit is where the run executed; the commit that adds its history file comes later.
 */
export function stateRows(run: RunRecord): Array<[string, string]> {
  const { git, stack: env } = run
  const rows: Array<[string, string]> = []
  rows.push([
    'Executed at',
    git
      ? `${git.sha.slice(0, 12)}${git.branch ? ` on ${git.branch}` : ''}${git.dirty ? ', dirty' : ', clean'} (the commit that adds this record is later)`
      : 'not a git repository',
  ])
  if (git?.dirty) {
    rows.push([
      'Uncommitted',
      git.worktreePatch
        ? `worktree.patch, ${git.worktreePatch.bytes} bytes, sha256 ${short(git.worktreePatch.sha256)}`
        : `not saved: ${git.worktreePatchNote ?? 'unknown'}${git.diffHash ? `; sha256 ${short(git.diffHash)}` : ''}`,
    ])
  }
  rows.push([
    'Lockfiles',
    run.dependencies.lockfiles.map((l) => `${l.path} ${short(l.sha256)}`).join(', ') ||
      'none found',
  ])
  rows.push([
    'Images',
    env.images.length
      ? env.images
          .map(
            (i) =>
              `${i.ref} · id ${short(i.id)} · ${i.repoDigests[0] ?? 'no registry digest (built locally)'} · CLI ${i.agentCli ?? 'n/a'}${i.dockerfile ? ` · dockerfile ${i.dockerfile.path} ${short(i.dockerfile.sha256)}` : ''}${i.install?.length ? ` · install ${i.install.length} on ${i.base}` : ''}`,
          )
          .join('; ')
      : 'none (fake sandbox)',
  ])
  rows.push(['Harnesses', env.harnesses.map(harnessLabel).join(', ') || 'none'])
  const resources = runResourcesLine(run.evals.flatMap((e) => e.attempts.map((a) => a.resources)))
  if (resources) rows.push(['Resources', resources])
  rows.push([
    'Environments',
    run.environments
      .map(
        (e) =>
          `${e.name} ${short(e.digest)}${e.skills.length ? ` · skills ${e.skills.map((s) => `${s.name}${s.commit ? `@${s.commit.slice(0, 7)}` : ''}`).join(', ')}` : ''}${e.mcp.length ? ` · mcp ${e.mcp.join(', ')}` : ''}${e.secrets.length ? ` · secrets ${e.secrets.join(', ')}` : ''}`,
      )
      .join('; ') || 'none',
  ])
  rows.push([
    'Judge',
    `${env.judge.model ?? 'none by default'}${env.judge.resolvedModels.length ? ` (served ${env.judge.resolvedModels.join(', ')})` : ''} · threshold ${env.judge.threshold} · version ${env.judge.version}`,
  ])
  rows.push([
    'Context',
    env.context.length
      ? `${env.context.length} file${env.context.length === 1 ? '' : 's'}: ${env.context.map((c) => `${c.path} ${short(c.sha256)}`).join(', ')}`
      : 'no skills, rules or MCP config found in the sandbox',
  ])
  rows.push([
    'Packages',
    Object.entries(env.packages)
      .map(([name, v]) => `${name} ${v}`)
      .join(' · '),
  ])
  const language = languageLabel(env)
  rows.push([
    'reeval',
    `${env.reeval} · ${runtimeLabel(env)}${language ? ` · ${language}` : ''} · ${env.os}/${env.arch}`,
  ])
  rows.push([
    'Runner',
    run.runner.kind === 'ci'
      ? `CI (${run.runner.provider})${run.runner.runUrl ? ` ${run.runner.runUrl}` : ''}`
      : `local · ${run.author}`,
  ])
  return rows
}

/**
 * Markdown for people and agents landing on a run cold. Built from `buildRunReport`
 * so every surface shares one view-model.
 */
export function renderSummary(run: RunRecord, opts: RunReportOptions = {}): string {
  return runReportMarkdown(buildRunReport(run, { links: { base: './' }, ...opts }))
}

/** The `RunReport` behind summary.md, in the run's folder beside it. */
export const REPORT_FILE = 'report.json'

/** summary.md and report.json for a run's folder, from one `RunReport`. */
export function summaryFiles(run: RunRecord, opts: RunReportOptions = {}): Map<string, Buffer> {
  const report = buildRunReport(run, { links: { base: './' }, ...opts })
  return new Map([
    ['summary.md', Buffer.from(runReportMarkdown(report))],
    [REPORT_FILE, Buffer.from(`${JSON.stringify(report, null, 2)}\n`)],
  ])
}
