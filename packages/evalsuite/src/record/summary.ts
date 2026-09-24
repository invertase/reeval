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
  const judgements = e.trials.flatMap((t) => t.judgements)
  if (judgements.length === 0) return ''
  return judgements.map((j) => `${j.verdict} ${j.score.toFixed(2)}/${j.threshold}`).join(', ')
}

/** Markdown for people and agents landing on a run cold. Links are relative to the run directory. */
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
    '## Evals',
    '',
    '| | Eval | Time | Judge | Files |',
    '|---|---|---|---|---|',
  ]
  for (const e of run.evals) {
    const t = e.trials[0]
    lines.push(
      `| ${OUTCOME_MARK[e.outcome]} | ${cell(e.id)} | ${t ? formatMs(t.durationMs) : ''} | ${judgeCell(e)} | [${e.slug}](evals/${e.slug}/1/result.json) |`,
    )
  }
  const failures = run.evals.filter((e) => e.outcome === 'fail' || e.outcome === 'infra_error')
  if (failures.length > 0) {
    lines.push('', '## Failures')
    for (const e of failures) {
      const t = e.trials[0]
      if (!t) continue
      lines.push('', `### ${OUTCOME_MARK[e.outcome]} ${e.id}`, '')
      if (t.error) {
        lines.push(
          `**${t.error.kind}**`,
          '',
          '```',
          t.error.message.split('\n').slice(0, 20).join('\n'),
          '```',
          '',
        )
      }
      for (const j of t.judgements) {
        lines.push(
          `- Judge **${j.verdict}** ${j.score.toFixed(2)} (threshold ${j.threshold}, ${j.model}): ${j.question}${j.reason ? ` — ${j.reason}` : ''}`,
        )
      }
      for (const c of t.checks) {
        lines.push(`- Check exit ${c.exitCode}: \`${cell(c.command)}\` ([log](${c.log.path}))`)
      }
      const links = [
        t.files.transcript && `[transcript](${t.files.transcript.path})`,
        t.files.diff && `[diff](${t.files.diff.path})`,
        t.files.judgeInput && `[judge input](${t.files.judgeInput.path})`,
        t.files.final && `[final messages](${t.files.final.path})`,
        `[result](${t.result.path})`,
      ].filter(Boolean)
      lines.push(`- Files: ${links.join(' · ')}`)
    }
  }
  lines.push('')
  return lines.join('\n')
}
