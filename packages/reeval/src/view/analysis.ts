// What `reeval analyze` writes: one LLM reading of a digest of facts, with every claim's citations
// checked. Browser-safe, so the studio's Analysis tab renders the same document the CLI prints.

/** Bumped when the system prompt or output schema changes: an older analysis is superseded. */
export const ANALYSIS_PROMPT_VERSION = 'analysis-v6'
/** Bumped when the digest's shape or selection rules change. */
export const DIGEST_VERSION = 4

export type Confidence = 'high' | 'medium' | 'low'

export type AnalysisClaim = {
  text: string
  /** Fact (`F3`), evidence (`E2`, `E2:L39`), attempt (`r2/scaffold/reeval-good#1`) or check ids. */
  cites: string[]
  confidence: Confidence
  /** Exact spans from the cited evidence; a claim whose quote isn't there is dropped. */
  quotes?: string[]
  /** Numbers in the text that no cited fact or evidence contains. */
  unverifiedNumbers?: string[]
}

export type AnomalyKind = 'es-bug' | 'eval-design' | 'judge' | 'noise' | 'other'
export type AnalysisAnomaly = { text: string; kind: AnomalyKind; cites: string[] }

export type ActionKind = 'skill' | 'docs' | 'eval' | 'judge' | 'es' | 'harness'
export type Level = 'high' | 'medium' | 'low'

export type AnalysisAction = {
  title: string
  target: string
  kind: ActionKind
  change: string
  expectedEffect: string
  /** An `reeval` command that shows the effect; null when the model's didn't parse as reeval's CLI. */
  verify: string | null
  /** Why the model's verify command was rejected. */
  verifyProblem?: string
  impact: Level
  effort: Level
  cites: string[]
}

export type AnalysisBody = {
  tldr: string
  whatHappened: AnalysisClaim[]
  results: AnalysisClaim[]
  why: AnalysisClaim[]
  anomalies: AnalysisAnomaly[]
  actions: AnalysisAction[]
  confidence: { overall: Confidence; why: string }
}

export type AnalysisValidation = {
  /** Citations checked, and those that named nothing in the digest. */
  citations: number
  invalid: string[]
  /** Claims, anomalies and actions dropped for having no valid citation or an invented quote. */
  dropped: number
  commands: number
  invalidCommands: string[]
  unverifiedNumbers: number
}

export type AnalysisScope = {
  kind: 'run'
  head: string
  /** Resolved once, so a nearer ancestor recorded later doesn't change what this analysed. */
  base: string | null
  /** An eval filter (substring of the eval id), or null for every eval. */
  evals: string | null
}

export type AnalysisDoc = {
  kind: 'es-analysis'
  schemaVersion: 1
  scope: AnalysisScope
  /** The run the analysis belongs to: the scope's head. */
  anchor: string
  inputs: {
    records: Array<{ runId: string; sha256: string }>
    digestVersion: number
    digestHash: string
  }
  promptVersion: string
  model: string
  resolvedModel: string | null
  route: 'direct' | 'gateway' | 'fake'
  usage: { inputTokens: number | null; outputTokens: number | null }
  latencyMs: number
  createdAt: string
  author: string
  validation: AnalysisValidation
  analysis: AnalysisBody
  /** Short attempt ids used in citations, and where each attempt is. */
  attempts: Record<string, { runId: string; evalSlug: string; attempt: string }>
  /** Each cited fact or evidence id, summarised in one line. */
  cited: Record<string, string>
  /**
   * Why `analysis.agent`'s run summary failed; its `analysis` is then empty. `reeval analyze` treats
   * a cached one as a miss and calls the model again.
   */
  error?: string
}

/**
 * `analysis.agent`'s note on one eval and harness of a run, written once that harness's attempts
 * finish: `.reeval/analysis/<runId>/notes/<eval slug>__<harness slug>.json`.
 */
export type AnalysisNote = {
  kind: 'reeval-analysis-note'
  schemaVersion: 1
  runId: string
  evalId: string
  /** The harness id, as in the cell key. */
  harness: string
  model: string
  resolvedModel: string | null
  createdAt: string
  /** The attempt ids (`<cell key>#<n>`) the note covers. */
  attempts: string[]
  /** Empty when the call failed. */
  text: string
  /** Why the call failed; the run's outcomes don't change. */
  error?: string
  usage: { inputTokens: number | null; outputTokens: number | null }
}

/** One analysis file the studio can show: saved in the run's folder, or in the local cache. */
export type AnalysisEntry = { file: string; source: 'saved' | 'cached'; doc: AnalysisDoc }
export type AnalysisIndex = {
  runId: string
  entries: AnalysisEntry[]
  /** `analysis.agent`'s notes on the run, by eval and harness; absent when there are none. */
  notes?: AnalysisNote[]
}

export const analysisDataPath = (runId: string) => `data/analysis/${runId}.json`

/** The newest analysis that wrote a TL;DR, for the studio run header. */
export function pinnedAnalysis(entries: readonly AnalysisEntry[]): AnalysisEntry | undefined {
  return sortAnalyses([...entries]).find(
    (e) => e.doc.error === undefined && e.doc.analysis.tldr.length > 0,
  )
}

/** Newest first, saved before cached at the same time. */
export function sortAnalyses(entries: AnalysisEntry[]): AnalysisEntry[] {
  return [...entries].sort((a, b) =>
    a.doc.createdAt === b.doc.createdAt
      ? a.source === b.source
        ? 0
        : a.source === 'saved'
          ? -1
          : 1
      : a.doc.createdAt < b.doc.createdAt
        ? 1
        : -1,
  )
}

/** Superseded by a newer prompt or digest version: the studio says so. */
export const isSuperseded = (doc: AnalysisDoc) =>
  doc.promptVersion !== ANALYSIS_PROMPT_VERSION || doc.inputs.digestVersion !== DIGEST_VERSION
