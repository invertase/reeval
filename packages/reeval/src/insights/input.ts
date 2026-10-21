// What the insight model sees for one eval: its name, prompts, judge questions and check labels
// (for classification), and its facts keyed by their `SuiteResult` path, with each effect as the
// word the output prints. No intervals, rates or p-values: the model can't repeat what it never
// sees. Each attempt's final message is there for named-tool extraction, and a failed attempt's
// transcript lines as `L<n>`, citable as `transcript:<attempt>#L<n>`.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AttemptRecord, EvalEntry, RunRecord } from '../history/types.ts'
import { sha256 } from '../ids.ts'
import { clip } from '../text.ts'
import type { Job } from '../view/insights.ts'
import { parseTranscript } from '../view/model.ts'
import type {
  Across,
  CaseResult,
  CellResult,
  CheckResult,
  Effect,
  EvalResult,
  SuiteResult,
} from '../view/suite.ts'
import { cancelledOf, countedOf } from '../view/suite.ts'

/** The words an effect prints as, and the only ones a sentence may use for it. */
export const EFFECT_WORDS: Record<Effect, string> = {
  better: 'helped',
  worse: 'made it worse',
  same: 'no difference',
  unclear: "can't tell yet",
}

/** One fact the model may cite, by its path. */
export type InsightFact = { path: string; kind: string } & Record<string, unknown>

export type InsightAttempt = {
  /** `<cell path>#<n>`. */
  id: string
  cell: string
  outcome: string
  /** The agent's final message, clipped. */
  lastText: string
  /** A failed attempt's transcript lines, `L<n> …`, each citable as `transcript:<id>#L<n>`. */
  lines: string[]
}

/** Where an insight sentence can go, as the eval's layout opens them. */
export type InsightSlots = {
  /** Row paths that take one sentence each. */
  rows: string[]
  findings: boolean
  namedTools: boolean
}

/** One eval as the classifier and the insight model see it. */
export type InsightInput = {
  call: 'classify' | 'insights'
  eval: {
    path: string
    /** The eval's name, or a family's template: the author's statement of what it asks. */
    name: string
    group: string[]
    file: string
    across: Across
    family: boolean
    verdict: string
  }
  /** The first attempt's prompts, in order. */
  prompts: string[]
  judgeQuestions: string[]
  checks: string[]
  /** Set on the insights call: the classification. */
  intent?: { job: Job; question: string; subject: { tool?: string; change?: string } }
  /** Set on the insights call. */
  slots?: InsightSlots
  facts: InsightFact[]
  attempts: InsightAttempt[]
  /** What was left out to fit the eval's size cap (`trim.ts`), when anything was. */
  trimmed?: string[]
  /** On a regeneration: why the earlier sentences were refused. */
  retry?: string[]
}

/** The headline call's input: each eval's verdict and answer, and the run's tally with its total. */
export type HeadlineInput = {
  call: 'headline'
  /**
   * Counts results, not evals: each case of a family counts one, as the tally line does, and
   * `total` is their sum, so no count is the model's arithmetic; `errors` (outside any eval) aren't
   * results and stay out of it. The eval count is `evals.length`.
   */
  tally: SuiteResult['tally'] & { total: number; unit: 'results' }
  evals: Array<{ path: string; name: string; verdict: string; answer: string | null }>
  retry?: string[]
}

const TEXT_CHARS = 1500
const LINE_CHARS = 200
const LINES = 14

const verdictOf = (o: string) => (o === 'infra_error' ? 'infra error' : o)

const armOf = (c: CellResult) => c.variant ?? (c.environment === '-' ? 'baseline' : c.environment)

function checkFact(k: CheckResult, measured: boolean): InsightFact {
  const o = k.outcome
  if (o.status === 'not run')
    return { path: k.path, kind: 'check', label: k.label, result: 'not run' }
  const answered = o.passed + o.failed + o.errored
  return {
    path: k.path,
    kind: 'check',
    label: k.label,
    result: `${o.passed} of ${answered} passed`,
    ...(o.notRun ? { notRun: o.notRun } : {}),
    ...(o.errored ? { couldNotCheck: o.errored } : {}),
    ...(o.assertion ? { assertion: clip(o.assertion.trim().split('\n')[0] ?? '', 240) } : {}),
    ...(k.effect && measured ? { effect: EFFECT_WORDS[k.effect] } : {}),
  }
}

/**
 * A cell's facts. Its tries leave out the attempts the run's interrupt cancelled, as its row
 * does; under a cancelled eval or case (`measured` false) no effect is given, so none is claimed.
 */
function cellFacts(c: CellResult, measured: boolean): InsightFact[] {
  const cancelled = cancelledOf(c)
  const out: InsightFact[] = [
    {
      path: c.path,
      kind: 'cell',
      harness: c.harness,
      arm: armOf(c),
      sandbox: c.sandbox,
      verdict: verdictOf(c.outcome),
      passed: `${c.passed} of ${countedOf(c)} tries`,
      ...(c.infraError ? { infraErrors: c.infraError } : {}),
      ...(cancelled ? { cancelled } : {}),
      ...(c.baseline ? { baseline: true } : {}),
      ...(c.effect && measured ? { effect: EFFECT_WORDS[c.effect] } : {}),
      ...(c.context.length ? { context: c.context } : {}),
      ...(c.errors.length
        ? { errors: c.errors.map((e) => `${e.kind}: ${clip(e.message, LINE_CHARS)}`) }
        : {}),
    },
    ...c.checks.map((k) => checkFact(k, measured)),
  ]
  if (c.effort) {
    out.push({
      path: `${c.path}/effort`,
      kind: 'effort',
      toolCalls: c.effort.tools,
      seconds: c.effort.agentMs === null ? null : Math.round(c.effort.agentMs / 100) / 10,
      tokens: c.effort.tokens,
    })
  }
  return out
}

function caseFact(k: CaseResult): InsightFact {
  const passed = k.cells.reduce((n, c) => n + c.passed, 0)
  const counted = k.cells.reduce((n, c) => n + countedOf(c), 0)
  return {
    path: k.path,
    kind: 'case',
    label: k.label,
    verdict: verdictOf(k.outcome),
    passed: `${passed} of ${counted} tries`,
  }
}

/** Every fact of the eval, its own node first. */
export function evalFacts(e: EvalResult): InsightFact[] {
  const out: InsightFact[] = [
    {
      path: e.path,
      kind: e.family ? 'family' : 'eval',
      name: e.name,
      verdict: verdictOf(e.outcome),
      ...(e.cases ? { cases: e.cases.length } : {}),
    },
  ]
  const measured = e.outcome !== 'cancelled'
  for (const c of e.cells ?? []) out.push(...cellFacts(c, measured))
  for (const k of e.cases ?? []) {
    out.push(caseFact(k))
    for (const c of k.cells) out.push(...cellFacts(c, measured && k.outcome !== 'cancelled'))
  }
  for (const p of e.pooled ?? []) {
    out.push({
      path: p.path,
      kind: 'all cases',
      arm: p.key,
      ...(measured ? { effect: EFFECT_WORDS[p.effect] } : {}),
      verdict: p.outcome,
      pairs: p.pairs,
    })
  }
  return out
}

/** The record's evals behind a result: the eval, or each of a family's cases, with their cells' paths. */
export function entriesOf(record: RunRecord, e: EvalResult) {
  const cells = (entry: EvalEntry, results: CellResult[]) =>
    new Map(
      results.map((c) => [c.key, c] as const).filter(([k]) => entry.cells.some((x) => x.key === k)),
    )
  if (e.cases) {
    return e.cases.flatMap((k) => {
      const entry = record.evals.find((x) => x.id === k.id)
      return entry ? [{ entry, cells: cells(entry, k.cells) }] : []
    })
  }
  const entry = record.evals.find((x) => x.id === e.id)
  return entry ? [{ entry, cells: cells(entry, e.cells ?? []) }] : []
}

/** An attempt's id in insights: its cell's path and its number. */
export const attemptId = (cell: CellResult, a: Pick<AttemptRecord, 'n'>) => `${cell.path}#${a.n}`

/** A pass or a fail the agent made: not an infra error, a skip, or one the interrupt cancelled. */
const counted = (a: AttemptRecord) =>
  a.outcome === 'pass' || (a.outcome === 'fail' && a.error?.kind !== 'aborted')

/** Each counted attempt's id and its whole final message, as the record keeps it. */
export function attemptTexts(record: RunRecord, e: EvalResult): Map<string, string> {
  const out = new Map<string, string>()
  for (const { entry, cells } of entriesOf(record, e)) {
    for (const a of entry.attempts) {
      const cell = cells.get(a.cell)
      if (cell && counted(a)) out.set(attemptId(cell, a), a.turns.at(-1)?.text ?? '')
    }
  }
  return out
}

function describeEvent(line: ReturnType<typeof parseTranscript>[number]): string | null {
  switch (line.type) {
    case 'text':
      return `text: ${line.text}`
    case 'tool':
      return `tool ${line.tool}${line.ok ? '' : ' (failed)'}: ${JSON.stringify(line.input)}`
    case 'web-search':
      return `web search: ${line.query}`
    case 'web-fetch':
      return `web fetch: ${line.url}`
    case 'error':
      return `error: ${line.message}`
    default:
      return null
  }
}

/** A failed attempt's last tool calls and messages, numbered by their line in transcript.jsonl. */
async function transcriptLines(runDir: string, a: AttemptRecord): Promise<string[]> {
  if (a.outcome !== 'fail' || !a.files.transcript) return []
  const text = await readFile(join(runDir, ...a.files.transcript.path.split('/')), 'utf8').catch(
    () => null,
  )
  if (!text) return []
  const out: string[] = []
  text.split('\n').forEach((raw, i) => {
    const [line] = raw.trim() ? parseTranscript(raw) : []
    const shown = line && describeEvent(line)
    if (shown) out.push(`L${i + 1} ${clip(shown.replace(/\s+/g, ' '), LINE_CHARS)}`)
  })
  return out.slice(-LINES)
}

async function attemptsOf(
  record: RunRecord,
  runDir: string | null,
  e: EvalResult,
): Promise<InsightAttempt[]> {
  const out: InsightAttempt[] = []
  for (const { entry, cells } of entriesOf(record, e)) {
    for (const a of entry.attempts) {
      const cell = cells.get(a.cell)
      if (!cell || !counted(a)) continue
      out.push({
        id: attemptId(cell, a),
        cell: cell.path,
        outcome: a.outcome,
        lastText: clip(a.turns.at(-1)?.text ?? '', TEXT_CHARS),
        lines: runDir ? await transcriptLines(runDir, a) : [],
      })
    }
  }
  return out
}

const unique = (xs: string[]) => [...new Set(xs.filter(Boolean))]

/** The prompts, judge questions and check labels classification reads after the name. */
function declared(record: RunRecord, e: EvalResult) {
  const entries = entriesOf(record, e).map((x) => x.entry)
  const first = entries
    .flatMap((x) => x.attempts)
    .filter((a) => a.turns.length)
    .sort((a, b) => (a.seq ?? Infinity) - (b.seq ?? Infinity))[0]
  return {
    prompts: (first?.turns ?? []).map((t) => clip(t.prompt, 1000)),
    judgeQuestions: unique(
      entries.flatMap((x) => x.attempts.flatMap((a) => a.judgements.map((j) => j.question))),
    ),
    checks: unique(
      entries.flatMap((x) => x.cells.flatMap((c) => (c.checks ?? []).map((k) => k.label))),
    ),
    sources: entries[0]?.sources ?? [],
  }
}

/** The eval's input to both of its calls; `call` and the insights call's fields are set by the caller. */
export async function evalInput(
  record: RunRecord,
  runDir: string | null,
  e: EvalResult,
): Promise<Omit<InsightInput, 'call'>> {
  const { prompts, judgeQuestions, checks } = declared(record, e)
  return {
    eval: {
      path: e.path,
      name: e.template ?? e.name,
      group: e.group,
      file: e.id.split(' › ')[0] ?? '',
      across: e.across,
      family: e.family,
      verdict: verdictOf(e.outcome),
    },
    prompts,
    judgeQuestions,
    checks,
    facts: evalFacts(e),
    attempts: await attemptsOf(record, runDir, e),
  }
}

/** The classification's cache key: what it read, the model and the prompt version. */
export function classificationKey(
  record: RunRecord,
  e: EvalResult,
  model: string,
  promptVersion: string,
): string {
  const { prompts, judgeQuestions, checks, sources } = declared(record, e)
  return sha256(
    JSON.stringify({ id: e.id, sources, prompts, judgeQuestions, checks, model, promptVersion }),
  )
}

/** A fact as the model sees it: its short id (`F1`), which is what it cites. */
export type ModelFact = InsightFact & { id: string }

/** An attempt as the model sees it: `A1`, its cell's fact id, and its lines citable as `A1#L<n>`. */
export type ModelAttempt = Omit<InsightAttempt, 'id' | 'cell'> & { id: string; cell: string }

/** One eval's call as the model sees it: facts, attempts and row slots by short id. */
export type ModelInsightInput = Omit<InsightInput, 'facts' | 'attempts' | 'slots'> & {
  facts: ModelFact[]
  attempts: ModelAttempt[]
  slots?: Omit<InsightSlots, 'rows'> & { rows: string[] }
}

/** The headline call as the model sees it: each eval by its short id. */
export type ModelHeadlineInput = Omit<HeadlineInput, 'evals'> & {
  evals: Array<HeadlineInput['evals'][number] & { id: string }>
}

/** Turns the model's short ids back into paths; anything it doesn't know stays as written. */
export type Ids = {
  cite: (cite: string) => string
  row: (row: string) => string
  attempt: (attempt: string) => string
}

const TRANSCRIPT_ID = /^(A\d+)#L(\d+)$/
const ID = String.raw`\b[FA]\d+(?:#L\d+)?\b`
const ID_LIST = new RegExp(String.raw`\s*[([]${ID}(?:\s*(?:,|;|and)\s*${ID})*[)\]]`, 'g')

/** A short id left in a sentence's text, which the reader would see. */
export const ID_IN_TEXT = new RegExp(ID)

/** The text without the bracketed id lists models append as citations (`… each (F2, F7).`). */
export const withoutIdLists = (text: string): string => text.replace(ID_LIST, '')

/**
 * The eval's input with a short id for each fact (`F1`…) and attempt (`A1`…), and the map back:
 * the model cites ids, not the long percent-encoded paths, and the validator sees paths again.
 */
export function modelInput(input: InsightInput): { input: ModelInsightInput; ids: Ids } {
  const factIds = new Map(input.facts.map((f, i) => [f.path, `F${i + 1}`]))
  const attemptIds = new Map(input.attempts.map((a, i) => [a.id, `A${i + 1}`]))
  const facts = new Map([...factIds].map(([path, id]) => [id, path]))
  const attempts = new Map([...attemptIds].map(([path, id]) => [id, path]))
  const view: ModelInsightInput = {
    ...input,
    facts: input.facts.map((f) => ({ id: factIds.get(f.path) as string, ...f })),
    attempts: input.attempts.map((a) => ({
      ...a,
      id: attemptIds.get(a.id) as string,
      cell: factIds.get(a.cell) ?? a.cell,
    })),
    ...(input.slots
      ? { slots: { ...input.slots, rows: input.slots.rows.map((r) => factIds.get(r) ?? r) } }
      : {}),
  }
  const cite = (c: string) => {
    const t = TRANSCRIPT_ID.exec(c.trim())
    if (t) {
      const attempt = attempts.get(t[1] as string)
      return attempt ? `transcript:${attempt}#L${t[2]}` : c
    }
    return facts.get(c.trim()) ?? c
  }
  return {
    input: view,
    ids: {
      cite,
      row: (r) => facts.get(r.trim()) ?? r,
      attempt: (a) => attempts.get(a.trim()) ?? a,
    },
  }
}

/** The headline call's input with a short id for each eval, and the map back to their paths. */
export function modelHeadlineInput(input: HeadlineInput): {
  input: ModelHeadlineInput
  ids: Ids
} {
  const paths = new Map(input.evals.map((e, i) => [`F${i + 1}`, e.path]))
  const cite = (c: string) => paths.get(c.trim()) ?? c
  return {
    input: { ...input, evals: input.evals.map((e, i) => ({ id: `F${i + 1}`, ...e })) },
    ids: { cite, row: cite, attempt: (a) => a },
  }
}
