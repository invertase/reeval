// A run's remarks: what's wrong with the evals themselves, from deterministic rules over the run's
// facts and the history. Written beside the record, never part of it, so no verdict, count or
// exit code reads them. Browser-safe, so the studio can read the same document the CLI prints.

/** `<history>/<run>/remarks.json`, beside the record. */
export const REMARKS_FILE = 'remarks.json'

/** A run's remarks, `<history>/<run>/remarks.json`. Written only when the run raised one. */
export type RunRemarks = {
  kind: 'reeval-remarks'
  schemaVersion: 1
  runId: string
  createdAt: string
  /**
   * Every remark this run raised, ranked, including those an earlier run printed first
   * (`firstSeenRun`), which don't print again.
   */
  remarks: Remark[]
}

/** Each remark kind's severity. */
export const REMARK_KINDS: Record<Remark['kind'], { severity: 'concern' | 'suggestion' }> = {
  'too-few-tries': { severity: 'suggestion' },
  'check-never-fails': { severity: 'suggestion' },
  'flaky-check': { severity: 'concern' },
  'slow-mcp-start': { severity: 'concern' },
  'proxy-only-egress': { severity: 'concern' },
  'setup-process-secret': { severity: 'concern' },
  'workspace-too-large': { severity: 'concern' },
}

/** A remark about the eval's quality, not about the agent. */
export type Remark = {
  /**
   * sha256(kind, evalId, the eval's sources hash, and for `slow-mcp-start` the server): one remark
   * per kind (and server) per eval version.
   */
  id: string
  evalId: string
  kind:
    | 'too-few-tries'
    | 'check-never-fails'
    | 'flaky-check'
    | 'slow-mcp-start'
    | 'proxy-only-egress'
    | 'setup-process-secret'
    | 'workspace-too-large'
  /** Fixed by kind (`REMARK_KINDS`). */
  severity: 'concern' | 'suggestion'
  /** One plain sentence: what's wrong. */
  text: string
  /** Facts from this run (or history facts) showing it mattered now. */
  evidence: string[]
  /** An edit at a source location (`source:<file>#L<n>`) in the eval. */
  fix: { at: string; edit: string }
  /**
   * The first run that printed this `id`, or this run when none has: it prints only in that run,
   * except the kinds about the environment, which print in every run they happen.
   */
  firstSeenRun: string
  /**
   * Whether this run's `reeval run` output printed it: false when an earlier run printed it, or
   * when the cap or a run without `-v` left it out, so a later run prints it.
   */
  printed?: boolean
}
