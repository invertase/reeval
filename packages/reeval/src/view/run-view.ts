import type { AttemptRecord, EvalEntry, FileRef, RunRecord } from '../history/types.ts'
import type {
  AttemptFacts,
  AttemptSummary,
  AttemptView,
  CellView,
  EvalView,
  RunView,
} from './api.ts'
import { VIEW_VERSION } from './api.ts'
import { type ClassifiedCall, classifyAttempt } from './classify.ts'
import { cellEffort } from './effort.ts'
import { runHeader } from './header.ts'

export type RunViewOptions = {
  /** Whether the run is in the history folder, not only `.reeval/runs`. */
  recorded: boolean
  /** Each attempt's kept transcript.jsonl, by attempt key; an attempt without one gets null facts. */
  transcripts?: ReadonlyMap<string, string>
}

/** Counts an attempt's classified tool calls into its facts. */
function countFacts(calls: readonly ClassifiedCall[]): AttemptFacts {
  const byClass: AttemptFacts['byClass'] = {
    context: 0,
    dependency: 0,
    web: 0,
    verify: 0,
    workspace: 0,
  }
  const skills = new Map<string, AttemptFacts['skills'][number]>()
  const files = new Map<string, AttemptFacts['contextFiles'][number]>()
  for (const call of calls) {
    byClass[call.class]++
    for (const { skill, source } of call.skills) {
      const seen = skills.get(skill)
      if (seen) seen.reads++
      else skills.set(skill, { skill, source, reads: 1, firstLine: call.line })
    }
    for (const path of call.files) {
      const seen = files.get(path)
      if (seen) seen.reads++
      else files.set(path, { path, reads: 1, firstLine: call.line })
    }
  }
  return {
    toolCalls: calls.length,
    byClass,
    skills: [...skills.values()],
    contextFiles: [...files.values()],
  }
}

/**
 * One attempt's facts from its transcript, its calls classified as `reeval query` classifies them
 * against the skills and MCP servers of the attempt's environment.
 */
export function attemptFacts(
  record: RunRecord,
  a: AttemptRecord,
  transcript: string,
): AttemptFacts {
  const digest = record.evals
    .find((e) => e.attempts.includes(a))
    ?.cells.find((c) => c.key === a.cell)?.environmentDigest
  const env = record.environments.find((x) => x.digest === digest)
  const declared = { skills: env?.skills.map((s) => s.name) ?? [], mcp: env?.mcp ?? [] }
  return countFacts(classifyAttempt(a, declared, transcript).calls)
}

const factsOf = (record: RunRecord, a: AttemptRecord, transcript: string | undefined) =>
  transcript === undefined ? null : attemptFacts(record, a, transcript)

const tally = (statuses: readonly string[]) => ({
  passed: statuses.filter((s) => s === 'pass').length,
  failed: statuses.filter((s) => s !== 'pass').length,
})

function attemptSummary(
  e: EvalEntry,
  a: AttemptRecord,
  facts: AttemptFacts | null,
): AttemptSummary {
  return {
    key: a.key,
    id: a.id,
    evalKey: e.key,
    cell: a.cell,
    ...(a.case !== undefined ? { case: a.case } : {}),
    n: a.n,
    outcome: a.outcome,
    error: a.error,
    startedAt: a.startedAt,
    durationMs: a.durationMs,
    usage: a.usage,
    servedModels: a.servedModels,
    effort: a.effort,
    servedEffort: a.servedEffort,
    assertions: tally((a.assertions ?? []).map((x) => x.status)),
    judgements: tally(a.judgements.map((j) => j.verdict)),
    facts,
    transcript: !!a.files.transcript,
  }
}

function evalView(
  record: RunRecord,
  e: EvalEntry,
  transcripts: RunViewOptions['transcripts'],
): EvalView {
  const checks = new Set<string>()
  for (const a of e.attempts) for (const x of a.assertions ?? []) checks.add(x.label)
  return {
    key: e.key,
    id: e.id,
    slug: e.slug,
    name: e.name,
    file: e.file,
    group: e.group,
    tags: e.tags,
    outcome: e.outcome,
    passRate: e.passRate,
    fingerprint: e.fingerprint,
    ...(e.compare ? { compare: e.compare } : {}),
    ...(e.cases ? { cases: e.cases } : {}),
    ...(e.lifts ? { lifts: e.lifts } : {}),
    checks: [...checks],
    cells: e.cells.map((c): CellView => ({ ...c, effortStats: cellEffort(e, c.key) })),
    attempts: e.attempts.map((a) =>
      attemptSummary(e, a, factsOf(record, a, transcripts?.get(a.key))),
    ),
  }
}

/**
 * The view of one run that a studio page draws, from its record and the transcripts it is given.
 * Pure, and free of Node: the same inputs give the same view in the CLI, a browser or a Worker.
 */
export function buildRunView(record: RunRecord, options: RunViewOptions): RunView {
  return {
    viewVersion: VIEW_VERSION,
    header: runHeader(record, options.recorded),
    stack: record.stack,
    config: record.config,
    plan: record.plan,
    profile: record.profile,
    environments: record.environments,
    artifacts: record.artifacts,
    errors: record.errors ?? [],
    evals: record.evals.map((e) => evalView(record, e, options.transcripts)),
  }
}

const isFileRef = (value: unknown): value is FileRef =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as FileRef).path === 'string' &&
  typeof (value as FileRef).sha256 === 'string' &&
  typeof (value as FileRef).bytes === 'number'

/** Every file the attempt's record refers to, in the order the record names them, once each. */
export function attemptFileRefs(a: AttemptRecord): FileRef[] {
  const refs = new Map<string, FileRef>()
  const walk = (value: unknown) => {
    if (Array.isArray(value)) for (const v of value) walk(v)
    else if (typeof value === 'object' && value !== null) {
      if (isFileRef(value) && !refs.has(value.path)) {
        refs.set(value.path, { path: value.path, sha256: value.sha256, bytes: value.bytes })
      }
      for (const v of Object.values(value)) walk(v)
    }
  }
  walk(a)
  return [...refs.values()]
}

/**
 * One attempt of a run, by key: its record without turns and context, with its facts when its
 * transcript is given, or null if no such attempt.
 */
export function buildAttemptView(
  record: RunRecord,
  attemptKey: string,
  transcript?: string,
): AttemptView | null {
  for (const e of record.evals) {
    const a = e.attempts.find((x) => x.key === attemptKey)
    if (!a) continue
    const { turns, context, ...rest } = a
    return {
      ...rest,
      evalKey: e.key,
      turns: turns.length,
      contextFiles: context.length,
      facts: factsOf(record, a, transcript),
      fileRefs: attemptFileRefs(a),
    }
  }
  return null
}
