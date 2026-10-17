// The shapes `reeval report` reads and writes. `CliInvocation` is persisted (one line of
// `.reeval/cli.jsonl`) and snapshotted in `schema/`; the bundle is written for people to read.

/** One `reeval` command, as the CLI logs it when it ends: redacted and path-scrubbed on disk too. */
export type CliInvocation = {
  at: string
  reeval: string
  /** The arguments after `reeval`, with every flag value and argument replaced by `<value>` or `<arg>`. */
  argv: string[]
  /** `run`, `studio build`, …; null when the command line didn't parse. */
  command: string | null
  exitCode: number
  durationMs: number
  /** The run `reeval run` wrote, when it got that far. */
  runId: string | null
  /** What ended the command with an error: a usage error, one reeval expects, or a crash. */
  error: {
    kind: 'usage' | 'expected' | 'crash'
    name: string
    message: string
    stack: string | null
  } | null
  /** Errors the run reported that no eval owned. */
  unhandledErrors: string[]
}

export type ReportAttempt = {
  key: string
  outcome: string
  error: { kind: string; message: string } | null
  turnErrors: string[]
  /** The debug files kept for the attempt, relative to its `.reeval/debug` directory. */
  debugFiles: string[]
  /** The last lines of its debug.log. */
  debugLog: string[]
  /** The last lines of its trace.ndjson, each cut to 500 characters. */
  trace: string[]
  /** Its refused or failed gateway requests from requests.ndjson. */
  requests: string[]
}

/** Everything `reeval report` collected: versions and settings, never a value from the config. */
export type ReportBundle = {
  kind: 'reeval-report'
  version: 1
  createdAt: string
  reeval: string
  node: string
  npm: string | null
  os: { platform: string; release: string; arch: string }
  packageManager: { name: string; version: string | null; from: string } | null
  ci: boolean
  agent: string | null
  /** Names of the `REEVAL_*` and secret-looking variables set; never their values. */
  env: string[]
  invocation: CliInvocation | null
  doctor: unknown
  config: {
    file: string
    optionKeys: string[]
    harnesses: string[]
    sandboxes: string[]
    profiles: Array<{ name: string; keys: string[]; defaults: string[] }>
  } | null
  configError: string | null
  run: {
    runId: string
    status: string
    outcome: string
    summary: Record<string, number>
    stack: unknown
    failures: ReportAttempt[]
    /** More failing attempts than the report inlines. */
    moreFailures: number
  } | null
  runError: string | null
  /**
   * `masked` counts every masked value in the bundle and its attached logs; `upstream` how many
   * of them reeval had masked already, in the records and logs the report read.
   */
  redaction: { masked: number; upstream: number; paths: string[] }
}
