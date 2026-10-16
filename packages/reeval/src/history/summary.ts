import { sampleReasons } from '../compare/pairs.ts'
import { clip, formatDuration } from '../text.ts'
import type { CompareAnswer, Outcome } from '../types.ts'
import { cellContrast, effortLabel } from '../view/effort.ts'
import { cellJudgeRates, cellUsage, judgeRatesLabel } from '../view/judgements.ts'
import {
  formatUsage,
  harnessLabel,
  isUngatedMiss,
  languageLabel,
  runtimeLabel,
} from '../view/model.ts'
import { warnings } from './state.ts'
import type { AttemptRecord, CellRecord, CheckTally, EvalEntry, RunRecord } from './types.ts'

export const OUTCOME_MARK: Record<Outcome, string> = {
  pass: '✓',
  fail: '✗',
  infra_error: '!',
  skipped: '↓',
}

/** Enough to read the agent's conclusion; the record and transcript have it whole. */
const LAST_MESSAGE_LIMIT = 4000

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')

export function summaryCounts(s: RunRecord['summary']): string {
  const parts = [
    s.pass && `${s.pass} passed`,
    s.fail - s.notGated > 0 && `${s.fail - s.notGated} failed`,
    s.notGated > 0 && `${s.notGated} missed, not gated`,
    s.infraError && `${s.infraError} infra error`,
    s.skipped && `${s.skipped} skipped`,
  ].filter(Boolean)
  if (parts.length === 0) return 'no evals ran'
  const scope = s.attempts === s.evals ? '' : ` (${s.attempts} attempts, ${s.evals} evals)`
  return `${parts.join(' · ')}${scope}`
}

const signedPoints = (x: number) => `${x >= 0 ? '+' : '−'}${Math.round(Math.abs(x) * 100)}`

/** A gate policy as written in the config: `all`, or `passRate 0.8`. */
export const gateLabel = (gate: CellRecord['gate']) =>
  gate === 'all' || gate === 'none' ? gate : `passRate ${gate.passRate}`

/**
 * `lift +40 pts (95% −12…+72, 4/5 vs 2/5)`, and `within noise` when the interval spans 0: at a
 * few attempts per cell, a point estimate alone says far more than the attempts can.
 */
export function liftLabel(lift: NonNullable<CellRecord['lift']>): string {
  const { interval, variant, control } = lift
  const range = `95% ${signedPoints(interval.lo)}…${signedPoints(interval.hi)}`
  const counts = `${variant.pass}/${variant.counted} vs ${control.pass}/${control.counted}`
  return `lift ${signedPoints(lift.points)} pts (${range}, ${counts})${lift.withinNoise ? ', within noise' : ''}`
}

const answered = (t: CheckTally) => t.pass + t.fail + t.notRun

const VERDICT_ORDER: Record<string, number> = { discriminates: 0, mixed: 1 }

/**
 * A variant cell's checks against its control's, those that tell them apart first:
 * `loads the skill 2/2 vs 0/2 · exports greet 2/2 vs 2/2 (doesn't discriminate)`. Empty
 * without a control's tally.
 */
export function checksLabel(cell: CellRecord): string {
  const rows = (cell.checks ?? []).filter((k) => k.control && k.verdict)
  return rows
    .map((k, i) => ({ k, i }))
    .sort(
      (a, b) =>
        (VERDICT_ORDER[a.k.verdict ?? ''] ?? 2) - (VERDICT_ORDER[b.k.verdict ?? ''] ?? 2) ||
        a.i - b.i,
    )
    .map(({ k }) => {
      const control = k.control as CheckTally
      const notRun = k.notRun + control.notRun
      const notes = [
        notRun ? `${notRun} not run` : '',
        k.verdict === 'both-pass' || k.verdict === 'both-fail' ? "doesn't discriminate" : '',
      ].filter(Boolean)
      return `${k.label} ${k.pass}/${answered(k)} vs ${control.pass}/${answered(control)}${notes.length ? ` (${notes.join(', ')})` : ''}`
    })
    .join(' · ')
}

/** Every variant cell's checks that can't tell it from its control: they pass, or fail, on both. */
export function undiscriminating(evals: EvalEntry[]) {
  return evals.flatMap((entry) =>
    entry.cells.flatMap((cell) =>
      (cell.checks ?? [])
        .filter((k) => k.verdict === 'both-pass' || k.verdict === 'both-fail')
        .map((check) => ({ entry, cell, check })),
    ),
  )
}

/** `evals/s.eval.ts › greets  fake/skilled/fake  exports greet: passes on both`. */
export const undiscriminatingLabel = ({
  entry,
  cell,
  check,
}: ReturnType<typeof undiscriminating>[number]) =>
  `${entry.id}  ${cell.key}  ${check.label}: ${check.verdict === 'both-pass' ? 'passes' : 'fails'} on both`

const rateText = (r: CompareAnswer['rates'][number]) =>
  `${r.name} ${r.wins}/${r.n} (${Math.round((r.wins / r.n) * 100)}%)`

/**
 * One compare question's answer: `"Which is cleaner?" within: with-skill 2/2 (100%), plain 0/2
 * (0%) · 2 votes, 0 ties · google/gemini-3.8-flash`, or why it has no votes.
 */
export function answersLabel(answer: CompareAnswer): string {
  const q = `"${clip(answer.question, 80)}"`
  const ties = answer.votes.filter((v) => v.winner === 'tie').length
  const cuts = (['within', 'across'] as const).flatMap((cut) => {
    const rates = answer.rates.filter((r) => r.cut === cut)
    return rates.length ? [`${cut}: ${rates.map(rateText).join(', ')}`] : []
  })
  const votes = answer.votes.length
  const tally = `${votes} vote${votes === 1 ? '' : 's'}, ${ties} tie${ties === 1 ? '' : 's'}`
  const by = answer.resolvedModel ?? answer.model
  const failed = answer.error !== undefined ? ` · failed: ${clip(answer.error, 200)}` : ''
  if (votes === 0 && answer.error === undefined) {
    return `${q} no pairs to judge: attempts that failed their checks are left out`
  }
  return `${q} ${[...cuts, tally, by].join(' · ')}${failed}`
}

/** `fake/-/fake 0/2 (control, not gated) · fake/with-skill/fake 2/2 (lift +100 pts …)`. */
export function cellCounts(e: EvalEntry): string {
  return e.cells
    .map((c) => {
      const notes = [
        c.role === 'control' && e.cells.some((x) => x.role === 'variant') ? 'control' : '',
        c.gate === 'none' ? 'not gated' : '',
        c.gate !== 'all' && c.gate !== 'none' ? `gate ${gateLabel(c.gate)}` : '',
        c.lift ? liftLabel(c.lift) : '',
        ...[checksLabel(c)].flatMap((checks) => (checks ? [`checks ${checks}`] : [])),
        ...[cellContrast(e, c.key)].flatMap((effort) =>
          effort ? [`effort ${effortLabel(effort)}`] : [],
        ),
        ...[judgeRatesLabel(cellJudgeRates(e, c.key))].filter(Boolean),
        ...[formatUsage(cellUsage(e, c.key))].filter((u): u is string => Boolean(u)),
        c.overrides.length ? `overrides ${c.overrides.join(', ')}` : '',
      ].filter(Boolean)
      return `${c.key} ${c.pass}/${c.pass + c.fail}${notes.length ? ` (${notes.join(', ')})` : ''}`
    })
    .join(' · ')
}

function judgeCell(e: EvalEntry): string {
  const judgements = e.attempts.flatMap((a) => a.judgements)
  if (judgements.length === 0) return ''
  return judgements.map((j) => `${j.verdict} ${j.score.toFixed(2)}/${j.threshold}`).join(', ')
}

/** Markdown for people and agents landing on a run cold. Links are relative to the artifact dir. */
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
    `${env.es} · ${runtimeLabel(env)}${language ? ` · ${language}` : ''} · ${env.os}/${env.arch}`,
  ])
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
    `# reeval run ${run.runId}`,
    '',
    `${summaryCounts(run.summary)}${run.status === 'complete' ? '' : ` · **${run.status === 'budget' ? 'budget reached' : run.status}**`} · started ${run.startedAt} (${formatDuration(run.durationMs)})`,
    '',
    `Plan: ${run.profile ? `profile ${run.profile.name} (${run.profile.reason}) · ` : ''}${run.plan.evals} evals · ${run.plan.cells} cells · ${run.plan.attempts} attempts${run.budget ? ` · budget ${[run.budget.attempts !== undefined ? `${run.budget.attempts} attempts` : '', run.budget.duration ?? ''].filter(Boolean).join(', ')}` : ''}`,
    '',
    ...run.plan.sandboxWarnings.map((w) => `> **Warning:** ${w.message}\n`),
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
    '| | Eval | Time or cells | Judge |',
    '|---|---|---|---|',
  ]
  for (const e of run.evals) {
    const a = e.attempts[0]
    const time = e.todo
      ? 'todo'
      : e.attempts.length > 1
        ? cellCounts(e)
        : a
          ? formatDuration(a.durationMs)
          : ''
    lines.push(`| ${OUTCOME_MARK[e.outcome]} | ${cell(e.id)} | ${cell(time)} | ${judgeCell(e)} |`)
  }
  // Failures first, but passes get the same detail: why something passed matters too. Expected
  // misses (ungated cells) come after the passes, collapsed: they fail neither the eval nor the run.
  const rank = (o: Outcome) => (o === 'fail' || o === 'infra_error' ? 0 : o === 'pass' ? 1 : 2)
  for (const e of [...run.evals].sort((x, y) => rank(x.outcome) - rank(y.outcome))) {
    if (e.outcome === 'skipped') continue
    lines.push('', `### ${OUTCOME_MARK[e.outcome]} ${e.id}`, '')
    const multi = e.attempts.length > 1
    if (multi) lines.push(`Cells: ${cellCounts(e)}`, '')
    if (e.answers?.length) {
      for (const a of e.answers) {
        lines.push(`- Question: ${cell(answersLabel(a))}`)
        for (const reason of sampleReasons(a.votes)) lines.push(`  - ${cell(reason)}`)
      }
      lines.push('')
    }
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
    `- Agent: ${act.fileEdits} file edits · ${act.tools} other tool calls · ${web(act.webSearches, 'web searches')} · ${web(act.webFetches, 'fetches')} · ${formatDuration(act.reasoningMs)} reasoning`,
  )
  for (const j of a.judgements) {
    const retried = j.retries?.length
      ? `, after ${j.retries.length} ${j.retries.length === 1 ? 'retry' : 'retries'}`
      : ''
    lines.push(
      `- Judge **${j.verdict}** ${j.score.toFixed(2)} (threshold ${j.threshold}, ${j.model}${retried}): ${j.question}`,
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
