// The digest `reeval analyze` hands a model: facts computed by reeval (ids F1…), evidence excerpts chosen
// by rule (ids E1…, transcript lines keep their numbers as L<n>), and an attempts table with short
// ids. Deterministic: the same records give the same digest, byte for byte, so it can be cached.
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { commandSummary } from '../cli-spec.ts'
import { sampleReasons } from '../compare/pairs.ts'
import type { HistoryDb } from '../history/db.ts'
import { FLAKY_MIN_ATTEMPTS, LIFT_MIN_COUNTED } from '../history/facts.ts'
import type { AttemptRecord, EvalEntry, RunRecord } from '../history/types.ts'
import { sha256 } from '../ids.ts'
import { clip } from '../text.ts'
import { DIGEST_VERSION } from '../view/analysis.ts'
import { compare } from '../view/compare.ts'
import { familyEffortLabel, familyLiftLabel, familyRateLabel } from '../view/family.ts'
import { runHeader } from '../view/header.ts'

export type DigestFact = { id: string; kind: string } & Record<string, unknown>
export type DigestEvidence = {
  id: string
  ref: string
  why: string
  lines: string[]
  /** 1 is kept longest when the digest is over its cap. */
  priority: number
}
export type DigestAttempt = {
  run: string
  runId: string
  key: string
  eval: string
  evalSlug: string
  cell: string
  attempt: string
  outcome: AttemptRecord['outcome']
  tools: number
  agentS: number
  judge?: number
  checks: number
  artifacts: string | null
}

export type Digest = {
  digestVersion: number
  scope: { kind: 'run'; head: string; base: string | null; evals: string | null }
  runs: Record<
    string,
    { runId: string; commit: string | null; branch: string | null; status: string; summary: string }
  >
  setup: {
    harnesses: string[]
    judge: string
    environments: Array<{ name: string; skills: string[] }>
    evals: Array<{ tag: string; id: string; task: string; tags: string[] }>
  }
  rules: string[]
  cli: string[]
  instructions: string | null
  attempts: Record<string, DigestAttempt>
  facts: DigestFact[]
  evidence: DigestEvidence[]
  /** Evidence dropped to fit the cap, by id. */
  dropped: string[]
}

export type RunInput = { record: RunRecord; dir: string; bytes: Buffer }

export type DigestInput = {
  head: RunInput
  base: RunInput | null
  evalFilter: string | null
  db: HistoryDb
  maxChars: number
  instructions?: string
}

export const RULES = [
  `Lift (variant pass@1 minus control pass@1) is insufficient (not measured, never a results line) when either side has fewer than ${LIFT_MIN_COUNTED} counted attempts; otherwise it is an effect only when its 95% interval (Newcombe) excludes 0, and within noise when the interval spans 0, whatever the point estimate.`,
  'When sources or the eval fingerprint differ across the compared runs, the pass@1 difference is not comparable: the eval changed. Never call it an effect. Do not put those mixed counts on a results line. The first line of the analysis says the eval changed. A lift is an effect only when sources match; the two-attempt floor still applies then.',
  'Effort (tool calls, agent time, and tokens when both sides have usage samples) is compared with an exact Mann-Whitney test: "fewer"/"more" at p < 0.05; "insufficient" when the attempt counts can never reach it (2 vs 2 cannot) — never because a harness dropped usage. Attempts without usage are left out of the token sample only. If either side then has no token sample, the token metric is omitted (no line, not insufficient). A Goose cell does not blank tokens on Cursor cells in the same study. Pooled across evals, tokens are an effect only when at least 2/3 of the strata that reported usage agree.',
  "A family fact is one pooled evaluate.each: its cases are paired samples of one suite, so its lift (Newcombe paired interval and McNemar at one attempt a case, a t interval over cases otherwise) is the result for those cases; their own pass-rate facts carry no lift. insufficient (fewer than 6 discordant pairs or 6 cases) is not measured. A family's minLift gates the pooled lower bound.",
  'Each factor claim has a tier: controlled (two cells in one run that differ in one factor), pooled (the same contrast over comparable runs, and across evals), observed (a change between runs, which is weaker; "confounded" when several parts changed), not_measured (one level only).',
  `A cell with mixed outcomes is flaky only with at least ${FLAKY_MIN_ATTEMPTS} counted attempts over comparable runs; below that it is "insufficient", not flaky.`,
  "Drift marked noise changed only an agent CLI's own runtime state (e.g. ~/.cursor/cli-config.json): not a real change, and those runs stay comparable.",
  'An eval where every cell passes at least 95% is saturated: pass@1 cannot tell cells apart there, effort can.',
  'Judge verdicts carry no recorded reason; an explanation of a failed verdict is your reading of the cited output, and must say so.',
  'A check (kind checks) whose verdict is both-pass or both-fail passes, or fails, on both the variant and its control: it is no evidence for or against the variant. Only discriminates rows say which requirement separated them.',
  "Compare-question win rates annotate the run: they never change pass, fail or the exit code. Cite them as annotation, never as a result that gates the run. A vote's reason is the model's wording: do not treat it as a check.",
]

const pts = (x: number | null | undefined) =>
  x === null || x === undefined ? null : `${x >= 0 ? '+' : '−'}${Math.round(Math.abs(x) * 100)}`
const liftText = (points: number, lo: number, hi: number) =>
  `${pts(points)} pts (95% ${pts(lo)}…${pts(hi)})`

/** Digest lift copy: sparse cells are not measured, and keep the counts. */
function digestLift(
  variantCounted: number,
  controlCounted: number,
  points: number,
  lo: number,
  hi: number,
): string {
  return Math.min(variantCounted, controlCounted) < LIFT_MIN_COUNTED
    ? `not enough attempts for lift (${variantCounted} vs ${controlCounted})`
    : liftText(points, lo, hi)
}

function digestLiftVerdict(
  variantCounted: number,
  controlCounted: number,
  withinNoise: boolean,
): 'insufficient' | 'within noise' | 'effect' {
  if (Math.min(variantCounted, controlCounted) < LIFT_MIN_COUNTED) return 'insufficient'
  return withinNoise ? 'within noise' : 'effect'
}

/** Observed sources (or eval fingerprint) drift is not an effect of the thing under test. */
function evalChangedLift(): string {
  return 'not comparable: the eval changed'
}

function sourcesKey(e: EvalEntry): string {
  return JSON.stringify(e.sources.map((s) => [s.path, s.sha256]))
}

/** The eval's sources, or the sources part of its fingerprint, differ across the two runs. */
function evalSourcesChanged(base: EvalEntry, head: EvalEntry): boolean {
  if (sourcesKey(base) !== sourcesKey(head)) return true
  const prev = new Map(base.cells.map((c) => [c.key, c.fingerprintParts.sources]))
  return head.cells.some((c) => prev.has(c.key) && prev.get(c.key) !== c.fingerprintParts.sources)
}

/** Short tags for the evals in scope: the file's base name, numbered when a file has several. */
function evalTags(evals: EvalEntry[]): Map<string, string> {
  const tags = new Map<string, string>()
  const bases = evals.map((e) => basename(e.file).replace(/\.(?:eval|es)\.ts$|\.[jt]s$/, ''))
  evals.forEach((e, i) => {
    const b = bases[i] as string
    const same = bases.filter((x) => x === b).length
    tags.set(e.key, same > 1 ? `${b}-${bases.slice(0, i + 1).filter((x) => x === b).length}` : b)
  })
  return tags
}

/** A cell's tag within its eval: its variant or `control`, prefixed by harness when there are several. */
function cellTags(e: EvalEntry): Map<string, string> {
  const harnesses = [...new Set(e.cells.map((c) => c.harness))]
  const kinds = [...new Set(e.cells.map((c) => c.harnessKind))]
  const prefix = (c: EvalEntry['cells'][number]) =>
    harnesses.length < 2 ? '' : `${kinds.length === harnesses.length ? c.harnessKind : c.harness}:`
  return new Map(e.cells.map((c) => [c.key, `${prefix(c)}${c.variant ?? 'control'}`]))
}

const counted = (a: AttemptRecord) => a.outcome === 'pass' || a.outcome === 'fail'

export async function buildDigest(input: DigestInput): Promise<Digest> {
  return (await buildDigestKeepingDropped(input)).digest
}

/** The digest, and the evidence dropped from it to fit its cap, whole, for tools to read back. */
export async function buildDigestKeepingDropped(
  input: DigestInput,
): Promise<{ digest: Digest; dropped: DigestEvidence[] }> {
  const { head, base, db } = input
  const runs = base ? [base, head] : [head]
  const short = new Map(runs.map((r, i) => [r.record.runId, `r${i + 1}`]))
  const needle = input.evalFilter?.toLowerCase() ?? null
  const inScope = (e: EvalEntry) => !needle || e.id.toLowerCase().includes(needle)
  const scopeEvals = head.record.evals.filter(inScope)
  const tags = evalTags(scopeEvals)
  const evalKeys = new Set(scopeEvals.map((e) => e.key))
  const tagOf = (key: string) => tags.get(key) ?? key
  const runIds = runs.map((r) => r.record.runId)

  const attempts: Record<string, DigestAttempt> = {}
  const idOf = new Map<string, string>()
  const cellTagOf = new Map<string, string>()
  for (const r of runs) {
    for (const e of r.record.evals) {
      if (!evalKeys.has(e.key)) continue
      const cells = cellTags(e)
      for (const [key, tag] of cells) cellTagOf.set(`${r.record.runId}\0${e.key}\0${key}`, tag)
      for (const a of e.attempts) {
        const id = `${short.get(r.record.runId)}/${tagOf(e.key)}/${cells.get(a.cell)}#${a.n}`
        idOf.set(`${r.record.runId}\0${a.key}`, id)
        const judge = a.judgements[0]
        const any = a.files.transcript ?? a.files.judgeInput ?? a.checks.find((c) => c.log)?.log
        attempts[id] = {
          run: short.get(r.record.runId) as string,
          runId: r.record.runId,
          key: a.key,
          eval: tagOf(e.key),
          evalSlug: e.slug,
          cell: cells.get(a.cell) as string,
          attempt: a.id,
          outcome: a.outcome,
          tools: a.activity.tools,
          agentS: Math.round(a.timings.agentMs / 1000),
          ...(judge ? { judge: Math.round(judge.score * 100) / 100 } : {}),
          checks: a.checks.length,
          artifacts: any ? `${r.record.runId}/${any.path.split('/').slice(0, 3).join('/')}` : null,
        }
      }
    }
  }
  const cellTag = (runId: string, evalKey: string, cell: string) =>
    cellTagOf.get(`${runId}\0${evalKey}\0${cell}`) ?? cell

  const facts: DigestFact[] = []
  const fact = (kind: string, body: Record<string, unknown>) =>
    facts.push({ id: `F${facts.length + 1}`, kind, ...body })
  const q = (sql: string) => db.query(sql).rows
  const list = (values: string[]) => values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ')
  const runList = list(runIds)
  const evalList = list([...evalKeys])

  // pass@1 and lift, per run and eval, from the records.
  for (const r of runs) {
    for (const e of r.record.evals) {
      if (!evalKeys.has(e.key)) continue
      fact('pass@1', {
        run: short.get(r.record.runId),
        eval: tagOf(e.key),
        cells: e.cells.map((c) => ({
          cell: cellTag(r.record.runId, e.key, c.key),
          pass: `${c.pass}/${c.pass + c.fail}`,
          ...(c.infraError ? { infraError: c.infraError } : {}),
          gated: c.gate !== 'none',
          ...(c.lift && !e.family
            ? {
                lift: digestLift(
                  c.lift.variant.counted,
                  c.lift.control.counted,
                  c.lift.points,
                  c.lift.interval.lo,
                  c.lift.interval.hi,
                ),
                verdict: digestLiftVerdict(
                  c.lift.variant.counted,
                  c.lift.control.counted,
                  c.lift.withinNoise,
                ),
              }
            : {}),
        })),
        ...(e.family ? { family: e.family.id, case: e.family.case } : {}),
      })
    }
    // A pooled evaluate.each: its cases' lift paired by case, which its cases' facts leave out.
    for (const f of r.record.families ?? []) {
      const member = r.record.evals.find((e) => e.family?.id === f.id && evalKeys.has(e.key))
      if (!member) continue
      fact('family', {
        run: short.get(r.record.runId),
        family: f.id,
        cases: f.ran === f.cases ? f.cases : `${f.ran} of ${f.cases}`,
        rates: f.rates.map((x) => ({
          cell: cellTag(r.record.runId, member.key, x.cell),
          passAt1: familyRateLabel(x),
        })),
        lifts: f.lifts.map((l) => ({
          cell: cellTag(r.record.runId, member.key, l.variant),
          lift: familyLiftLabel(l),
          verdict: l.verdict === 'lift' || l.verdict === 'drop' ? 'effect' : l.verdict,
          ...(l.minLift !== undefined ? { minLift: l.minLift, gate: l.outcome } : {}),
          ...(familyEffortLabel(l) ? { effort: familyEffortLabel(l) } : {}),
        })),
      })
    }
  }

  // Effort per run and eval: every cell, and each variant against its control.
  const effort = q(
    `SELECT * FROM effort_m WHERE run_id IN (${runList}) AND eval_key IN (${evalList}) ORDER BY run_id, rowid`,
  )
  const effortGroups = new Map<string, Array<Record<string, unknown>>>()
  for (const row of effort) {
    const id = `${row.run_id}\0${row.eval_key}`
    effortGroups.set(id, [...(effortGroups.get(id) ?? []), row])
  }
  for (const rows of effortGroups.values()) {
    const first = rows[0] as Record<string, unknown>
    const runId = first.run_id as string
    fact('effort', {
      run: short.get(runId),
      eval: tagOf(first.eval_key as string),
      cells: rows.map((row) => ({
        cell: cellTag(runId, row.eval_key as string, row.cell_key as string),
        n: row.n,
        medianToolCalls: row.tools_median,
        medianAgentS: row.agent_s_median,
        ...(row.tokens_median != null ? { medianTokens: row.tokens_median } : {}),
        ...(row.control_key
          ? {
              vsControl: {
                toolCalls: `${row.tools_median} vs ${row.control_tools_median} (×${Number(row.tools_ratio).toFixed(2)})`,
                agentS: `${row.agent_s_median} vs ${row.control_agent_s_median}`,
                p: row.tools_p,
                verdict: row.verdict,
                ...(row.tokens_verdict
                  ? {
                      tokens: `${row.tokens_median} vs ${row.control_tokens_median} (×${Number(row.tokens_ratio).toFixed(2)})`,
                      tokensP: row.tokens_p,
                      tokensVerdict: row.tokens_verdict,
                    }
                  : {}),
                ...(row.tokens_note ? { unreportedUsage: row.tokens_note } : {}),
              },
            }
          : {}),
      })),
    })
  }

  // Factor effects: pooled over comparable runs (per eval and across evals), harness and model
  // contrasts in these runs, what changed between runs, and what one level can't tell.
  const changedEvalKeys = new Set<string>()
  if (base) {
    for (const e of scopeEvals) {
      const prior = base.record.evals.find((x) => x.key === e.key)
      if (prior && evalSourcesChanged(prior, e)) changedEvalKeys.add(e.key)
    }
  }
  const harnesses = [...new Set(runs.flatMap((r) => r.record.stack.harnesses.map((h) => h.id)))]
  const factors = q(
    `SELECT * FROM factor_effects WHERE
      (tier = 'pooled' AND (eval_key IS NULL OR eval_key IN (${evalList})))
      OR (tier = 'controlled' AND factor != 'environment' AND run_id IN (${runList}) AND eval_key IN (${evalList}))
      OR (tier = 'observed' AND run_id IN (${runList}) AND eval_key IN (${evalList}))
      OR tier = 'not_measured'
     ORDER BY CASE tier WHEN 'pooled' THEN 0 WHEN 'controlled' THEN 1 WHEN 'observed' THEN 2 ELSE 3 END,
       factor, level, eval_key`,
  ).filter(
    (f) =>
      f.tier !== 'pooled' || f.factor !== 'environment' || harnesses.includes(f.context as string),
  )
  for (const f of factors) {
    // Pooled and observed rows name other runs. With no base they are not this run alone.
    if (!base && (f.tier === 'pooled' || f.tier === 'observed')) continue
    if (f.tier === 'not_measured') {
      fact('factor', { tier: f.tier, factor: f.factor, level: f.level, note: f.note })
      continue
    }
    // A pooled row that includes an eval-changed pair is not a contrast of the thing under test.
    if (f.tier === 'pooled') {
      if (f.eval_key && changedEvalKeys.has(f.eval_key as string)) continue
      if (!f.eval_key && changedEvalKeys.size) continue
    }
    const notComparable = f.pass_verdict === 'not_comparable' || f.factor === 'sources'
    fact('factor', {
      tier: f.tier,
      factor: f.factor,
      level: f.tier === 'observed' ? (short.get(f.level as string) ?? f.level) : f.level,
      baseline:
        f.tier === 'observed' ? (short.get(f.baseline as string) ?? f.baseline) : f.baseline,
      ...(f.tier === 'observed' ? {} : { context: f.context }),
      eval: f.eval_key ? tagOf(f.eval_key as string) : 'all evals',
      ...(f.run_id && f.tier !== 'observed' ? { run: short.get(f.run_id as string) } : {}),
      ...(f.strata && (f.strata as number) > 1 ? { strata: f.strata } : {}),
      ...(f.runs ? { runs: f.runs } : {}),
      ...(notComparable
        ? {
            lift: evalChangedLift(),
            passVerdict: 'not comparable',
          }
        : {
            passRate: `${f.variant_pass}/${f.variant_counted} vs ${f.control_pass}/${f.control_counted}`,
            lift: digestLift(
              f.variant_counted as number,
              f.control_counted as number,
              f.points as number,
              f.lo as number,
              f.hi as number,
            ),
            passVerdict: f.pass_verdict,
          }),
      toolCalls: f.tools_ratios,
      toolsP: f.tools_p,
      effortVerdict: f.effort_verdict,
      ...(f.tokens_verdict
        ? {
            tokensRatio: f.tokens_ratio,
            tokensP: f.tokens_p,
            tokensVerdict: f.tokens_verdict,
          }
        : {}),
      ...(f.tokens_note ? { unreportedUsage: f.tokens_note } : {}),
      ...(f.strata && (f.strata as number) > 1
        ? {
            consistentStrata: `${f.consistent}/${f.strata}`,
            separatedStrata: `${f.separated}/${f.strata}`,
          }
        : { separated: f.separated === 1 }),
      ...(f.note ? { note: f.note } : {}),
    })
  }

  // Did each attempt read the skills its environment placed?
  const reads = q(
    `SELECT run_id, eval_key, cell_key, skill, COUNT(*) AS attempts, SUM(read_line IS NOT NULL) AS read,
       GROUP_CONCAT(DISTINCT read_line) AS lines
     FROM skill_reads WHERE run_id IN (${runList}) AND eval_key IN (${evalList})
     GROUP BY run_id, eval_key, cell_key, skill ORDER BY run_id, eval_key, cell_key, skill`,
  )
  const byCell = new Map<
    string,
    { cell: string; skill: string; attempts: number; read: number; lines: Set<number> }
  >()
  for (const r of reads) {
    const cell = cellTag(r.run_id as string, r.eval_key as string, r.cell_key as string)
    const id = `${cell}\0${r.skill}`
    const entry = byCell.get(id) ?? {
      cell,
      skill: r.skill as string,
      attempts: 0,
      read: 0,
      lines: new Set(),
    }
    entry.attempts += r.attempts as number
    entry.read += r.read as number
    for (const l of String(r.lines ?? '')
      .split(',')
      .filter(Boolean))
      entry.lines.add(Number(l))
    byCell.set(id, entry)
  }
  if (byCell.size) {
    fact('skill-reads', {
      note: 'Attempts that read their placed skill (a tool call on skills/<name>/), and the transcript lines of the first read.',
      cells: [...byCell.values()].map((c) => ({
        cell: c.cell,
        skill: c.skill,
        read: `${c.read}/${c.attempts}`,
        firstReadAtLines: [...c.lines].sort((a, b) => a - b),
      })),
    })
  }

  // Saturation: pass rates pooled over these runs.
  const pooled = new Map<
    string,
    { pass: number; counted: number; cells: Map<string, [number, number]> }
  >()
  for (const r of runs) {
    for (const e of r.record.evals) {
      if (!evalKeys.has(e.key)) continue
      const p = pooled.get(e.key) ?? { pass: 0, counted: 0, cells: new Map() }
      for (const c of e.cells) {
        const [cp, cn] = p.cells.get(c.key) ?? [0, 0]
        p.cells.set(c.key, [cp + c.pass, cn + c.pass + c.fail])
        p.pass += c.pass
        p.counted += c.pass + c.fail
      }
      pooled.set(e.key, p)
    }
  }
  const saturated = [...pooled]
    .filter(([, p]) => [...p.cells.values()].every(([cp, cn]) => cn > 0 && cp / cn >= 0.95))
    .map(([key]) => tagOf(key))
  fact('saturation', {
    evals: [...pooled].map(([key, p]) => ({ eval: tagOf(key), pass: `${p.pass}/${p.counted}` })),
    saturated,
  })

  // The judge: how sure it was, and what failed.
  const judged = runs.flatMap((r) =>
    r.record.evals
      .filter((e) => evalKeys.has(e.key))
      .flatMap((e) => e.attempts.flatMap((a) => a.judgements.map((j) => ({ r, a, j })))),
  )
  if (judged.length) {
    fact('judge', {
      models: [...new Set(judged.map(({ j }) => j.resolvedModel ?? j.model))],
      threshold: [...new Set(judged.map(({ j }) => j.threshold))],
      verdicts: judged.length,
      pass: judged.filter(({ j }) => j.verdict === 'pass').length,
      scoresAtLeast098: judged.filter(({ j }) => j.score >= 0.98).length,
      nearThreshold: judged.filter(({ j }) => Math.abs(j.score - j.threshold) <= 0.1).length,
      failures: judged
        .filter(({ j }) => j.verdict === 'fail')
        .map(({ r, a, j }) => ({
          attempt: idOf.get(`${r.record.runId}\0${a.key}`),
          score: j.score,
        })),
      reasons: 'not recorded',
    })
  }

  // Failed attempts.
  const failures = runs
    .slice()
    .reverse()
    .flatMap((r) =>
      r.record.evals
        .filter((e) => evalKeys.has(e.key))
        .flatMap((e) =>
          e.attempts
            .filter((a) => a.outcome === 'fail' || a.outcome === 'infra_error')
            .map((a) => ({ r, e, a })),
        ),
    )
  for (const { r, e, a } of failures.slice(0, 8)) {
    const j = a.judgements.find((x) => x.verdict === 'fail')
    fact('failure', {
      attempt: idOf.get(`${r.record.runId}\0${a.key}`),
      outcome: a.outcome,
      errorKind: a.error?.kind ?? null,
      message: a.error ? clip(a.error.message.split('\n')[0] ?? '', 300) : null,
      gated: e.cells.find((c) => c.key === a.cell)?.gate !== 'none',
      ...(j ? { judge: { question: j.question, score: j.score, threshold: j.threshold } } : {}),
      failingChecks: a.checks
        .map((c, i) => ({ check: i + 1, exit: c.exitCode, command: c.command }))
        .filter((c) => c.exit !== 0),
    })
  }

  // Flaky cells over comparable runs.
  for (const f of q(`SELECT * FROM flaky_cells WHERE eval_key IN (${evalList})`)) {
    const cell = cellTag(head.record.runId, f.eval_key as string, f.cell_key as string)
    fact('flaky', {
      eval: tagOf(f.eval_key as string),
      cell,
      pass: `${f.pass}/${f.counted}`,
      runs: f.runs,
      wilson95: `${Math.round((f.lo as number) * 100)}…${Math.round((f.hi as number) * 100)}%`,
      verdict: f.verdict,
      cause: f.cause,
    })
  }

  // Compared runs whose eval sources (or sources fingerprint) differ are not an effect.
  if (base) {
    for (const e of scopeEvals) {
      const prior = base.record.evals.find((x) => x.key === e.key)
      if (!prior || !evalSourcesChanged(prior, e)) continue
      fact('eval-changed', {
        eval: tagOf(e.key),
        from: 'r1',
        to: 'r2',
        note: 'not comparable: the eval changed; the pass@1 difference is not an effect of the thing under test',
      })
    }
  }

  // Drift between the two runs, grouped by what changed.
  if (base) {
    const drift = q(
      `SELECT changed, changed_paths, noise, real_changed, COUNT(*) AS cells FROM drift
       WHERE run_id = '${head.record.runId}' AND prev_run_id = '${base.record.runId}' AND eval_key IN (${evalList})
       GROUP BY changed, changed_paths, noise, real_changed`,
    )
    for (const d of drift) {
      fact('drift', {
        from: 'r1',
        to: 'r2',
        cells: d.cells,
        changed: d.changed,
        ...(d.changed_paths ? { paths: String(d.changed_paths).split(', ') } : {}),
        verdict: d.noise ? 'noise: agent runtime state only' : `real change: ${d.real_changed}`,
      })
    }
    const rows = compare(runHeader(base.record, true), runHeader(head.record, true)).filter((row) =>
      scopeEvals.some((e) => e.id === row.id),
    )
    fact('compare', {
      base: 'r1',
      head: 'r2',
      rows: rows.map((row) => ({
        eval: tagOf(scopeEvals.find((e) => e.id === row.id)?.key ?? row.id),
        status: row.status,
        ...(row.changes?.length ? { changes: row.changes } : {}),
      })),
    })
  }

  // Compare questions: win rates by cut, ties, and a failed call. They never gate the run.
  for (const r of runs) {
    for (const e of r.record.evals) {
      if (!evalKeys.has(e.key)) continue
      for (const a of e.answers ?? []) {
        const ties = a.votes.filter((v) => v.winner === 'tie').length
        const reasons = sampleReasons(a.votes)
        fact('compare-question', {
          run: short.get(r.record.runId),
          eval: tagOf(e.key),
          question: clip(a.question, 120),
          model: a.resolvedModel ?? a.model,
          votes: a.votes.length,
          ties,
          ...(a.rates.length
            ? {
                rates: a.rates.map((x) => ({
                  cut: x.cut,
                  name: x.name,
                  wins: x.wins,
                  n: x.n,
                })),
              }
            : {}),
          ...(a.error ? { error: clip(a.error, 200) } : {}),
          ...(a.votes.length === 0 && a.error === undefined
            ? { note: 'no pairs to judge: attempts that failed their checks are left out' }
            : {}),
          ...(reasons.length ? { reasons } : {}),
        })
      }
    }
  }

  // Each variant cell's checks (expect labels) beside its control's, and whether each tells them apart.
  for (const r of runs) {
    for (const e of r.record.evals) {
      if (!evalKeys.has(e.key)) continue
      for (const c of e.cells) {
        const rows = (c.checks ?? []).filter((k) => k.control && k.verdict)
        if (!rows.length) continue
        fact('checks', {
          run: short.get(r.record.runId),
          eval: tagOf(e.key),
          cell: c.key,
          rows: rows.map((k) => ({
            label: clip(k.label, 80),
            variant: `${k.pass}/${k.pass + k.fail + k.notRun}`,
            control: `${k.control?.pass}/${(k.control?.pass ?? 0) + (k.control?.fail ?? 0) + (k.control?.notRun ?? 0)}`,
            verdict: k.verdict,
          })),
        })
      }
    }
  }

  // Evidence, by rule: failures first, then a passing twin, then tool strips of contrasting cells.
  const evidence: DigestEvidence[] = []
  const add = (ref: string, why: string, lines: string[], priority: number) => {
    if (lines.length) evidence.push({ id: `E${evidence.length + 1}`, ref, why, lines, priority })
  }
  const runOf = new Map(runs.map((r) => [r.record.runId, r]))
  const transcriptOf = async (runId: string, a: AttemptRecord) => {
    const r = runOf.get(runId)
    if (!r || !a.files.transcript) return null
    return readFile(join(r.dir, runId, ...a.files.transcript.path.split('/')), 'utf8').catch(
      () => null,
    )
  }
  const lastText = async (runId: string, a: AttemptRecord) => {
    const text = await transcriptOf(runId, a)
    if (!text)
      return a.turns.at(-1)?.text ? [`final: ${clip(a.turns.at(-1)?.text ?? '', 1400)}`] : []
    const lines = text.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const event = JSON.parse(lines[i] as string)
        if (event.type === 'text') return [`L${i + 1} text: ${clip(String(event.text), 1400)}`]
      } catch {}
    }
    return []
  }
  for (const { r, e, a } of failures.slice(0, 3)) {
    const id = idOf.get(`${r.record.runId}\0${a.key}`) as string
    const lines = await lastText(r.record.runId, a)
    const j = a.judgements.find((x) => x.verdict === 'fail')
    if (j)
      lines.push(
        `judge question: ${j.question}`,
        `judge score: ${j.score} (threshold ${j.threshold})`,
      )
    for (const [i, c] of a.checks.entries()) {
      if (c.exitCode === 0 || !c.log) continue
      const log = await readFile(
        join(r.dir, r.record.runId, ...c.log.path.split('/')),
        'utf8',
      ).catch(() => '')
      lines.push(
        `check ${i + 1} (exit ${c.exitCode}) ${c.command}:`,
        ...log.trimEnd().split('\n').slice(-15),
      )
    }
    add(
      `attempt:${id}`,
      `a failing attempt: its final message${j ? ' and the judge question it failed' : ''}`,
      lines,
      1,
    )
    if (j) {
      const twin = e.attempts.find((x) => x.cell === a.cell && x.outcome === 'pass')
      if (twin) {
        const twinId = idOf.get(`${r.record.runId}\0${twin.key}`) as string
        add(
          `attempt:${twinId}`,
          `the passing twin of ${id} (same cell): its final message`,
          await lastText(r.record.runId, twin),
          2,
        )
      }
    }
  }
  const strip = (runId: string, a: AttemptRecord) =>
    q(
      `SELECT line, tool, target FROM tool_calls WHERE run_id = '${runId}' AND attempt_key = '${a.key.replace(/'/g, "''")}' ORDER BY line LIMIT 20`,
    ).map((t) => `L${t.line} ${t.tool} ${clip(String(t.target), 90)}`)
  const medianAttempt = (list: AttemptRecord[]) =>
    [...list].sort((x, y) => x.activity.tools - y.activity.tools)[Math.floor((list.length - 1) / 2)]
  let strips = 0
  for (const e of scopeEvals) {
    if (strips >= 3) break
    const contrast = effort.find(
      (row) =>
        row.run_id === head.record.runId &&
        row.eval_key === e.key &&
        row.control_key &&
        (row.verdict === 'fewer' ||
          row.verdict === 'more' ||
          (row.tools_ratio !== null &&
            ((row.tools_ratio as number) <= 0.5 || (row.tools_ratio as number) >= 2))),
    )
    if (!contrast) continue
    strips++
    for (const cell of [contrast.cell_key, contrast.control_key] as string[]) {
      const a = medianAttempt(e.attempts.filter((x) => x.cell === cell && counted(x)))
      if (!a) continue
      const id = idOf.get(`${head.record.runId}\0${a.key}`) as string
      add(
        `tool-strip:${id}`,
        `the median-effort attempt of ${cellTag(head.record.runId, e.key, cell)} on ${tagOf(e.key)}: its first tool calls`,
        strip(head.record.runId, a),
        3,
      )
    }
  }

  const digest: Digest = {
    digestVersion: DIGEST_VERSION,
    scope: {
      kind: 'run',
      head: short.get(head.record.runId) as string,
      base: base ? 'r1' : null,
      evals: input.evalFilter,
    },
    runs: Object.fromEntries(
      runs.map((r) => [
        short.get(r.record.runId),
        {
          runId: r.record.runId,
          commit: r.record.git?.sha.slice(0, 7) ?? null,
          branch: r.record.git?.branch ?? null,
          status: r.record.status,
          summary: `${r.record.summary.pass}/${r.record.summary.attempts} attempts passed (${r.record.summary.notGated} failed, not gated)`,
        },
      ]),
    ),
    setup: {
      harnesses,
      judge: `${head.record.stack.judge.model ?? 'none'} threshold ${head.record.stack.judge.threshold}`,
      environments: head.record.environments.map((env) => ({
        name: env.name,
        skills: env.skills.map((s) => s.name),
      })),
      evals: scopeEvals.map((e) => ({
        tag: tagOf(e.key),
        id: e.id,
        task: clip(e.attempts[0]?.turns[0]?.prompt ?? '', 400),
        tags: e.tags,
      })),
    },
    rules: RULES,
    cli: commandSummary(),
    instructions: input.instructions ?? null,
    attempts,
    facts,
    evidence,
    dropped: [],
  }
  const dropped: DigestEvidence[] = []
  while (digestChars(digest) > input.maxChars && digest.evidence.length) {
    const worst = digest.evidence.reduce((a, b) => (b.priority >= a.priority ? b : a))
    digest.evidence = digest.evidence.filter((x) => x !== worst)
    digest.dropped.push(worst.id)
    dropped.push(worst)
  }
  return { digest, dropped }
}

export const digestChars = (d: Digest) => JSON.stringify(d).length

/** Content hash of the digest: the cache key's input side. */
export const digestHash = (d: Digest) => sha256(JSON.stringify(d))

/** Every id a citation may name, and the transcript lines each evidence item holds. */
export function citable(d: Digest) {
  const ids = new Set<string>([
    ...d.facts.map((f) => f.id),
    ...d.evidence.map((e) => e.id),
    ...Object.keys(d.attempts),
  ])
  const lines = new Map(
    d.evidence.map((e) => [
      e.id,
      new Set(
        e.lines.flatMap((l) => (/^L(\d+) /.exec(l) ? [Number(/^L(\d+) /.exec(l)?.[1])] : [])),
      ),
    ]),
  )
  return { ids, lines }
}
