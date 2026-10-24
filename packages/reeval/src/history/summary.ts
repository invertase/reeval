import { clip, fenced, formatDuration } from '../text.ts'
import type { Outcome } from '../types.ts'
import { colors } from '../ui/colors.ts'
import { render, tallyLine } from '../ui/layout.ts'
import type { RunInsights } from '../view/insights.ts'
import { checkLabels, checkTries, commandLine, labelledJudgements } from '../view/judgements.ts'
import {
  evalMarkOutcome,
  harnessLabel,
  isNotGatedPass,
  isUngatedMiss,
  languageLabel,
  runtimeLabel,
} from '../view/model.ts'
import { suiteResult } from '../view/suite.ts'
import { warnings } from './state.ts'
import type { AttemptRecord, RunRecord } from './types.ts'

export const OUTCOME_MARK: Record<Outcome, string> = {
  pass: '✓',
  fail: '✗',
  infra_error: '!',
  skipped: '↓',
}

/** Enough to read the agent's conclusion; the record and transcript have it whole. */
const LAST_MESSAGE_LIMIT = 4000

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')

/** `5 fail · 2 pass`, with the run's status when it didn't complete. */
export const runTally = (run: RunRecord) =>
  `${tallyLine(colors(false), suiteResult(run).tally)}${run.status === 'complete' ? '' : ` · ${run.status === 'budget' ? 'budget reached' : run.status}`}`

const short = (hash: string) => hash.replace(/^sha256:/, '').slice(0, 12)

/**
 * The state a run executed in, as label/value pairs, shared by summary.md and `reeval show`. The
 * commit is where the run executed; the commit that adds its history file comes later.
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

/** Markdown for people and agents landing on a run cold. Links are relative to the artifact dir. */
export function renderSummary(
  run: RunRecord,
  opts: { hint: boolean; insights?: RunInsights | null },
): string {
  const lines = [
    `# reeval run ${run.runId}`,
    '',
    `${runTally(run)} · started ${run.startedAt} (${formatDuration(run.durationMs)})`,
    '',
    `Plan: ${run.profile ? `profile ${run.profile.name} (${run.profile.reason}) · ` : ''}${run.plan.evals} evals · ${run.plan.cells} cells · ${run.plan.attempts} attempts${run.budget ? ` · budget ${[run.budget.attempts !== undefined ? `${run.budget.attempts} attempts` : '', run.budget.duration ?? ''].filter(Boolean).join(', ')}` : ''}`,
    '',
    ...run.plan.sandboxWarnings.map((w) => `> **Warning:** ${w.message}\n`),
    '## Results',
    '',
    ...fenced(
      render(suiteResult(run), opts.insights ?? null, {
        color: false,
        verbose: false,
        hint: opts.hint,
      }),
      'text',
    ),
    '',
    '## State',
    '',
    '| | |',
    '|---|---|',
    ...stateRows(run).map(([k, v]) => `| ${k} | ${cell(v)} |`),
    '',
    ...warnings(run).map((w) => `> **Warning:** ${w}\n`),
    `Record: [${run.runId}.json](../${run.runId}.json) · artifacts: ${run.artifacts}`,
    '',
    '## Attempts',
  ]
  // Failures first, but passes get the same detail: why something passed matters too. Expected
  // misses (ungated cells) come after the passes, collapsed: they fail neither the eval nor the run.
  const rank = (o: Outcome) => (o === 'fail' || o === 'infra_error' ? 0 : o === 'pass' ? 1 : 2)
  for (const e of [...run.evals].sort((x, y) => rank(x.outcome) - rank(y.outcome))) {
    if (e.outcome === 'skipped') continue
    const mark = isNotGatedPass(e) ? '○' : OUTCOME_MARK[evalMarkOutcome(e)]
    lines.push('', `### ${mark} ${e.id}${isNotGatedPass(e) ? ' · not gated' : ''}`, '')
    const multi = e.attempts.length > 1
    const inputs = (e.answers ?? []).filter((a) => a.input)
    for (const a of inputs) {
      lines.push(
        `- Question: ${cell(`"${clip(a.question, 80)}"`)} · [what the model saw](${a.input?.path})`,
      )
    }
    if (inputs.length) lines.push('')
    const attemptRank = (a: AttemptRecord) => (isUngatedMiss(e, a) ? 3 : rank(a.outcome))
    for (const a of [...e.attempts].sort((x, y) => attemptRank(x) - attemptRank(y))) {
      if (a.outcome === 'skipped') continue
      if (isUngatedMiss(e, a)) {
        if (multi) lines.push(`#### ○ ${a.id} · missed, not gated`, '')
        lines.push('<details><summary>Why it missed</summary>', '')
        attemptDetail(lines, a)
        lines.push('', '</details>')
        continue
      }
      if (multi) lines.push(`#### ${OUTCOME_MARK[a.outcome]} ${a.id}`, '')
      attemptDetail(lines, a)
    }
  }
  lines.push('')
  return lines.join('\n')
}

/** A failed verdict already says why a judge error failed the attempt; its message repeats it. */
export const repeatsVerdict = (a: Pick<AttemptRecord, 'error' | 'judgements'>) =>
  a.error?.kind === 'judge' && a.judgements.some((j) => j.verdict === 'fail')

function attemptDetail(lines: string[], a: AttemptRecord): void {
  if (a.error && !repeatsVerdict(a)) {
    lines.push(`**${a.error.kind}**`, '', ...fenced(a.error.message.split('\n').slice(0, 20)), '')
  }
  for (const turn of a.turns) {
    lines.push(
      `- Prompt (${turn.status}, ${formatDuration(turn.durationMs)}): ${clip(cell(turn.prompt), 200)}`,
    )
    if (turn.error) lines.push(`  - Error: ${clip(cell(turn.error), 500)}`)
  }
  const t = a.timings
  lines.push(
    `- Time: setup ${formatDuration(t.setupMs)} · agent ${formatDuration(t.agentMs)} · checks ${formatDuration(t.checksMs)} · judge ${formatDuration(t.judgeMs)}`,
  )
  const act = a.activity
  const web = (n: number | null, what: string) =>
    n === null ? `${what} not reported` : `${n} ${what}`
  lines.push(
    `- Agent: ${act.fileEdits} file edits · ${act.tools} other tool calls · ${web(act.webSearches, 'web searches')} · ${web(act.webFetches, 'fetches')} · ${formatDuration(act.reasoningMs)} reasoning${act.stalledTools ? ` · ${act.stalledTools} stalled tool${act.stalledTools === 1 ? '' : 's'} (≥2m)${act.maxToolMs ? `, longest ${formatDuration(act.maxToolMs)}` : ''}` : ''}`,
  )
  for (const { judgement: j, label, labelled } of labelledJudgements(a)) {
    const retried = j.retries?.length
      ? `, after ${j.retries.length} ${j.retries.length === 1 ? 'retry' : 'retries'}`
      : ''
    lines.push(
      `- Judge${labelled ? ` ${cell(label)}` : ''} **${j.verdict}** ${j.score.toFixed(2)} (threshold ${j.threshold}, ${j.model}${retried}): ${j.question}`,
    )
  }
  for (const q of a.answers ?? []) {
    const said = q.error
      ? `failed: ${clip(cell(q.error), 200)}`
      : `${q.choice !== undefined ? `**${cell(q.choice)}** ` : ''}${clip(cell(q.text), 300)}`
    lines.push(
      `- Question ${cell(`"${clip(q.question, 80)}"`)}: ${said}${q.input ? ` ([what the model saw](${q.input.path}))` : ''}`,
    )
  }
  const labels = checkLabels(a)
  a.checks.forEach((c, i) => {
    const label = labels[i]
    const tries = checkTries(c)
    lines.push(
      `- Check${label ? ` ${cell(label)}` : ''} exit ${c.exitCode}${tries ? ` (${tries})` : ''}: \`${cell(commandLine(c.command))}\`${c.log ? ` ([log](${c.log.path}))` : ''}`,
    )
  })
  if (a.changedFiles.length) {
    lines.push(
      `- Changed: ${a.changedFiles.map((f) => (f.count ? `\`${f.path}\` (${f.count} files)` : `${f.status} \`${f.path}\``)).join(', ')}`,
    )
  }
  const last = a.turns.at(-1)?.text
  if (last) {
    const shown = last.length > LAST_MESSAGE_LIMIT ? `${last.slice(0, LAST_MESSAGE_LIMIT)}…` : last
    lines.push(
      '',
      'Last message:',
      '',
      ...shown
        .trimEnd()
        .split('\n')
        .map((l) => `> ${l}`),
      '',
    )
  }
  const links = [
    a.files.setupLog && `[setup log](${a.files.setupLog.path})`,
    a.files.transcript && `[transcript](${a.files.transcript.path})`,
    a.files.diff && `[diff](${a.files.diff.path})`,
    a.files.judgeInput && `[judge input](${a.files.judgeInput.path})`,
  ].filter(Boolean)
  if (links.length) lines.push(`- Files: ${links.join(' · ')}`)
}
