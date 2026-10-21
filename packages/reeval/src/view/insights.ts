// A run's insights: what an analysis model says each eval asks and how the run answers it, as
// sentences that cite the run's facts (`SuiteResult` paths). Written create-only beside the
// record, never part of it: insights annotate, so no verdict, count or exit code reads them.
// Browser-safe, so the studio can render the same document the CLI prints.
import type { Across } from './suite.ts'

/** `<history>/<run>/insights.json`, beside the record. */
export const INSIGHTS_FILE = 'insights.json'

/** What one attempt tests. Only an analysis model can tell; without one every eval is `other`. */
export type Job = 'choose' | 'finish' | 'other'

/**
 * A run's insights, `<history>/<run>/insights.json`. Written create-only; the record is untouched.
 * They're for the facts they were written from: a `factsHash` that isn't the run's marks them stale.
 */
export type RunInsights = {
  kind: 'reeval-insights'
  schemaVersion: 1
  runId: string
  /** The analysis model, as configured (`google/gemini-3.8-flash`, or `fake`). */
  model: string
  /** The prompts' version: insights from another version were asked differently. */
  promptVersion: string
  /** sha256 of the run's `SuiteResult` as canonical JSON: the facts the model saw. */
  factsHash: string
  createdAt: string
  /** Over every call; `costUsd` is null when reeval doesn't know the model's price. */
  usage: { inputTokens: number; outputTokens: number; costUsd: number | null }
  /** One sentence for the whole run, citing facts; null when the model's was dropped. */
  headline: Sentence | null
  /** One per eval (a family is one), in the order the output prints them. */
  evals: EvalInsight[]
  /** Remarks about the evals' own quality, ranked. Empty: no kind is raised yet. */
  remarks: Remark[]
  /**
   * What the checks dropped, and how many sentences were asked for again, so the output can say
   * so. `drops` is each dropped sentence: its slot (`<eval> › answer`, `› row <path>`, `headline`),
   * its text and why.
   */
  validation: {
    dropped: number
    regenerated: number
    drops?: Array<{ slot: string; text: string; reason: string }>
  }
  /** Set when insights failed; the facts still print. */
  error?: string
}

export type EvalInsight = {
  /** The eval's `SuiteResult` path; for a family, the family's. */
  evalId: string
  intent: {
    /** What one attempt is testing. Can't be read from the cell shape. */
    job: Job
    /** What the cells compare. Deterministic, copied from the facts. */
    across: Across
    /** The eval's question in plain words: "Do agents pick Genkit for a production AI feature?" */
    question: string
    /** The tool a choose eval asks about, and the change a measure eval makes. */
    subject: { tool?: string; change?: string }
    /** How the eval name relates to what the eval checks. */
    name: 'states-intent' | 'no-intent' | 'contradicts'
    /**
     * sha256 of the eval's id, sources, first attempt's prompts, judge questions, check labels,
     * the model and the prompt version: the classification's cache key.
     */
    key: string
  }
  /** The answer to `question`, at most two sentences; null when it was dropped. */
  answer: Sentence | null
  /** Up to three supporting points: what moved, what broke, what the agent did. */
  findings: Sentence[]
  /**
   * At most one sentence per row (a case, an arm or a harness), keyed by the row's fact path.
   * Only rows the eval's layout opens a slot on are kept.
   */
  rows?: Array<Sentence & { row: string }>
  /**
   * Per attempt (`<cell path>#<n>`), the tools the reply recommended or used, each found
   * verbatim in that attempt's final message. Only on `choose` evals.
   */
  namedTools?: Array<{ attempt: string; tools: string[] }>
}

/**
 * A plain sentence citing the facts it states: `SuiteResult` paths
 * (`evals%2Fbilling.eval.ts › bills in pence/fake+-+fake/checks/amount`) or a transcript line
 * (`transcript:<cell path>#<n>#L<line>`). A sentence citing nothing is dropped.
 */
export type Sentence = { text: string; cites: string[] }

/** A remark about the eval's quality, not about the agent. Anything that fails a gate is dropped. */
export type Remark = {
  /** sha256(kind, evalId, the eval's sources hash): one remark per kind per eval version. */
  id: string
  evalId: string
  /** Closed set; an unknown kind is dropped. There is no general or free-form kind. */
  kind:
    | 'name-contradicts'
    | 'name-no-intent'
    | 'judge-too-loose'
    | 'judge-leaks-answer'
    | 'prompt-names-tool'
    | 'compound-judge'
    | 'too-few-tries'
    | 'check-never-fails'
    | 'flaky-check'
    | 'no-baseline'
  /** Fixed by kind, never chosen by the model. */
  severity: 'concern' | 'suggestion'
  /** One plain sentence: what's wrong. */
  text: string
  /** Where the problem is: `source:<file>#L<n>` with `quote`, checked against the file. */
  source?: { at: string; quote: string }
  /** Facts from this run (or history facts) showing it mattered now. */
  evidence: string[]
  /** A concrete edit at a location. */
  fix: { at: string; edit: string }
  origin: 'model' | 'deterministic'
  /** The run that first raised this `id`; it prints only in that run. */
  firstSeenRun: string
  /** Set on later runs once the cited span changed: the remark was acted on. */
  actedOn?: { run: string }
}
