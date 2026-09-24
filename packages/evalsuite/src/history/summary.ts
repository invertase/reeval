import type { Outcome } from '../types.ts'
import type { EvalEntry, RunRecord } from './types.ts'

export const OUTCOME_MARK: Record<Outcome, string> = {
  pass: '✓',
  fail: '✗',
  infra_error: '!',
  skipped: '↓',
}

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
export function renderSummary(run: RunRecord): string {
  const git = run.git
  const commit = git
    ? `\`${git.sha.slice(0, 12)}\`${git.branch ? ` on \`${git.branch}\`` : ''}${git.dirty ? ' (dirty)' : ''}`
    : 'not a git repository'
  const runner =
    run.runner.kind === 'ci'
      ? `CI (${run.runner.provider})${run.runner.runUrl ? ` [log](${run.runner.runUrl})` : ''}`
      : 'local'
  const lines = [
    `# ES run ${run.runId}`,
    '',
    `${summaryCounts(run.summary)}${run.status === 'interrupted' ? ' · **interrupted**' : ''}`,
    '',
    '| | |',
    '|---|---|',
    `| Started | ${run.startedAt} (${formatMs(run.durationMs)}) |`,
    `| Commit | ${commit} |`,
    `| Runner | ${runner} |`,
    `| Harness | ${run.config.harness}${run.config.model ? ` · ${run.config.model}` : ''} · agent CLI ${run.versions.agentCli ?? 'n/a'} |`,
    `| Sandbox | ${run.config.sandbox} · ${run.versions.image} |`,
    `| Judge | ${run.config.judgeModel} · threshold ${run.config.threshold} |`,
    `| Versions | es ${run.versions.es} · vitest ${run.versions.vitest} · node ${run.versions.node} |`,
    '',
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
    for (const turn of a.turns)
      lines.push(`- Prompt (${turn.status}): ${cell(turn.prompt).slice(0, 200)}`)
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
      lines.push(`- Changed: ${a.changedFiles.map((f) => `${f.status} \`${f.path}\``).join(', ')}`)
    }
    const links = [
      a.files.final && `[final messages](${a.files.final.path})`,
      a.files.transcript && `[transcript](${a.files.transcript.path})`,
      a.files.diff && `[diff](${a.files.diff.path})`,
      a.files.judgeInput && `[judge input](${a.files.judgeInput.path})`,
    ].filter(Boolean)
    if (links.length) lines.push(`- Files: ${links.join(' · ')}`)
  }
  lines.push('')
  return lines.join('\n')
}
