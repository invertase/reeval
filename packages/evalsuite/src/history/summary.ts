import type { Outcome } from '../types.ts'
import { warnings } from './state.ts'
import type { EvalEntry, RunRecord } from './types.ts'

export const OUTCOME_MARK: Record<Outcome, string> = {
  pass: '✓',
  fail: '✗',
  infra_error: '!',
  skipped: '↓',
}

/** Enough to read the agent's conclusion; the record and transcript have it whole. */
const LAST_MESSAGE_LIMIT = 4000

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')

export const formatMs = (ms: number) => {
  if (ms < 1000) return `${ms}ms`
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

export function summaryCounts(s: RunRecord['summary']): string {
  const parts = [
    s.pass && `${s.pass} passed`,
    s.fail && `${s.fail} failed`,
    s.infraError && `${s.infraError} infra error`,
    s.skipped && `${s.skipped} skipped`,
  ].filter(Boolean)
  return parts.join(' · ') || 'no evals ran'
}

function judgeCell(e: EvalEntry): string {
  const judgements = e.attempts.flatMap((a) => a.judgements)
  if (judgements.length === 0) return ''
  return judgements.map((j) => `${j.verdict} ${j.score.toFixed(2)}/${j.threshold}`).join(', ')
}

/** Markdown for people and agents landing on a run cold. Links are relative to the artifact dir. */
const short = (hash: string) => hash.replace(/^sha256:/, '').slice(0, 12)

/**
 * The state a run executed in, as label/value pairs, shared by summary.md and `es show`. The
 * commit is where the run executed; the commit that adds its history file comes later.
 */
export function stateRows(run: RunRecord): Array<[string, string]> {
  const { git, environment: env } = run
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
    'Image',
    env.image
      ? `${env.image.ref} · id ${short(env.image.id)} · ${env.image.repoDigests[0] ?? 'no registry digest (built locally)'}`
      : 'none (fake sandbox)',
  ])
  rows.push([
    'Agent',
    `${env.harness.kind}${env.harness.model ? ` · model ${env.harness.model}` : ''}${env.harness.resolvedModel ? ` (served ${env.harness.resolvedModel})` : ''} · CLI ${env.agentCli ?? 'n/a'}`,
  ])
  rows.push([
    'Judge',
    `${env.judge.model}${env.judge.resolvedModels.length ? ` (served ${env.judge.resolvedModels.join(', ')})` : ''} · threshold ${env.judge.threshold} · version ${env.judge.version}`,
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
  rows.push(['ES', `${env.es} · node ${env.node} · ${env.os}/${env.arch}`])
  rows.push([
    'Runner',
    run.runner.kind === 'ci'
      ? `CI (${run.runner.provider})${run.runner.runUrl ? ` ${run.runner.runUrl}` : ''}`
      : `local · ${run.author}`,
  ])
  return rows
}

export function renderSummary(run: RunRecord): string {
  const lines = [
    `# ES run ${run.runId}`,
    '',
    `${summaryCounts(run.summary)}${run.status === 'interrupted' ? ' · **interrupted**' : ''} · started ${run.startedAt} (${formatMs(run.durationMs)})`,
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
    '## Evals',
    '',
    '| | Eval | Time | Judge |',
    '|---|---|---|---|',
  ]
  for (const e of run.evals) {
    const a = e.attempts[0]
    lines.push(
      `| ${OUTCOME_MARK[e.outcome]} | ${cell(e.id)} | ${a ? formatMs(a.durationMs) : ''} | ${judgeCell(e)} |`,
    )
  }
  // Failures first, but passes get the same detail: why something passed matters too.
  const rank = (o: Outcome) => (o === 'fail' || o === 'infra_error' ? 0 : o === 'pass' ? 1 : 2)
  for (const e of [...run.evals].sort((x, y) => rank(x.outcome) - rank(y.outcome))) {
    const a = e.attempts[0]
    if (!a || e.outcome === 'skipped') continue
    lines.push('', `### ${OUTCOME_MARK[e.outcome]} ${e.id}`, '')
    if (a.error) {
      lines.push(
        `**${a.error.kind}**`,
        '',
        '```',
        a.error.message.split('\n').slice(0, 20).join('\n'),
        '```',
        '',
      )
    }
    for (const turn of a.turns) {
      lines.push(
        `- Prompt (${turn.status}, ${formatMs(turn.durationMs)}): ${cell(turn.prompt).slice(0, 200)}`,
      )
    }
    const t = a.timings
    lines.push(
      `- Time: setup ${formatMs(t.setupMs)} · agent ${formatMs(t.agentMs)} · checks ${formatMs(t.checksMs)} · judge ${formatMs(t.judgeMs)}`,
    )
    const act = a.activity
    lines.push(
      `- Agent: ${act.fileEdits} file edits · ${act.tools} other tool calls · ${act.webSearches} web searches · ${act.webFetches} fetches · ${formatMs(act.reasoningMs)} reasoning`,
    )
    for (const j of a.judgements) {
      lines.push(
        `- Judge **${j.verdict}** ${j.score.toFixed(2)} (threshold ${j.threshold}, ${j.model}): ${j.question}${j.reason ? ` — ${j.reason}` : ''}`,
      )
    }
    for (const c of a.checks) {
      lines.push(
        `- Check exit ${c.exitCode}: \`${cell(c.command)}\`${c.log ? ` ([log](${c.log.path}))` : ''}`,
      )
    }
    if (a.changedFiles.length) {
      lines.push(
        `- Changed: ${a.changedFiles.map((f) => (f.count ? `\`${f.path}\` (${f.count} files)` : `${f.status} \`${f.path}\``)).join(', ')}`,
      )
    }
    const last = a.turns.at(-1)?.text
    if (last) {
      const shown =
        last.length > LAST_MESSAGE_LIMIT ? `${last.slice(0, LAST_MESSAGE_LIMIT)}…` : last
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
      a.files.transcript && `[transcript](${a.files.transcript.path})`,
      a.files.diff && `[diff](${a.files.diff.path})`,
      a.files.judgeInput && `[judge input](${a.files.judgeInput.path})`,
    ].filter(Boolean)
    if (links.length) lines.push(`- Files: ${links.join(' · ')}`)
  }
  lines.push('')
  return lines.join('\n')
}
