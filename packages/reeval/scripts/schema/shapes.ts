import { fileURLToPath } from 'node:url'
import type { ShapeName } from '../../src/view/record.ts'

export const PACKAGE_DIR = fileURLToPath(new URL('../../', import.meta.url))
/** Where the committed snapshots live, one `<name>.schema.json` per shape. */
export const SNAPSHOT_DIR = fileURLToPath(new URL('../../schema/', import.meta.url))

/**
 * A shape reeval writes to disk and reads back later, perhaps from an older or newer reeval. Caches that
 * reeval rebuilds when its version changes (`.reeval/history-cache.json`, `.reeval/history.db`) aren't here.
 */
export type PersistedShape = {
  name: ShapeName
  file: string
  type: string
  /** Which files hold it. */
  where: string
  /** The field holding its schema version literal, when it has one. */
  versionField?: string
}

export const SHAPES: PersistedShape[] = [
  {
    name: 'run-record',
    file: 'src/history/types.ts',
    type: 'RunRecord',
    where: 'A run record: evals/.history/<run>.json and .reeval/runs/<run>.json',
    versionField: 'schemaVersion',
  },
  {
    name: 'transcript-line',
    file: 'src/view/model.ts',
    type: 'TranscriptLine',
    where: "One line of an attempt's transcript.jsonl in a run's artifacts",
  },
  {
    name: 'analysis',
    file: 'src/view/analysis.ts',
    type: 'AnalysisDoc',
    where:
      "A reeval analyze document, or analysis.agent's run summary: <run>/analysis/*.json and .reeval/analysis/<key>.json",
    versionField: 'schemaVersion',
  },
  {
    name: 'analysis-note',
    file: 'src/view/analysis.ts',
    type: 'AnalysisNote',
    where:
      'An analysis.agent note on one eval and harness: .reeval/analysis/<run>/notes/<eval>__<harness>.json',
    versionField: 'schemaVersion',
  },
  {
    name: 'insights',
    file: 'src/view/insights.ts',
    type: 'RunInsights',
    where:
      "A run's insights from reeval analyze --insights: <run>/insights.json in the history folder",
    versionField: 'schemaVersion',
  },
  {
    name: 'debug-request',
    file: 'src/view/debug.ts',
    type: 'DebugRequest',
    where: "One line of an attempt's .reeval/debug/…/requests.ndjson",
  },
  {
    name: 'live-progress',
    file: 'src/view/live.ts',
    type: 'LiveProgress',
    where:
      "A running reeval run's progress: .reeval/staging/<run>/live.json, read by reeval studio",
    versionField: 'schemaVersion',
  },
  {
    name: 'cli-invocation',
    file: 'src/report/types.ts',
    type: 'CliInvocation',
    where: 'One line of .reeval/cli.jsonl, the last reeval commands reeval report reads',
  },
]

/** Where the plan shapes' snapshots live: `schema/plan/<name>.schema.json`. */
export const PLAN_SNAPSHOT_DIR = fileURLToPath(new URL('../../schema/plan/', import.meta.url))

/**
 * A shape the engine sends, not one reeval persists: the spec a runner in another language codes
 * against. Its snapshot only has to match the code; `PROTOCOL` in src/engine/protocol.ts versions
 * a change.
 */
export type PlanShape = { name: string; file: string; type: string; where: string }

export const PLAN_SHAPES: PlanShape[] = [
  {
    name: 'declaration',
    file: 'src/declaration.ts',
    type: 'DeclarationTree',
    where: "An eval file's groups and evals as declared, with their options as data",
  },
  {
    name: 'config',
    file: 'src/types.ts',
    type: 'ReevalConfigData',
    where: 'reeval.yaml, or the config as data from another language',
  },
  {
    name: 'wire-test',
    file: 'src/engine/protocol.ts',
    type: 'WireTest',
    where: "One planned test, with its attempt, in a worker's collected message",
  },
  {
    name: 'to-worker',
    file: 'src/engine/protocol.ts',
    type: 'ToWorker',
    where: 'A message from the main process to a worker (src/engine/PROTOCOL.md)',
  },
  {
    name: 'from-worker',
    file: 'src/engine/protocol.ts',
    type: 'FromWorker',
    where: 'A message from a worker to the main process (src/engine/PROTOCOL.md)',
  },
]

export const PROTOCOL_SNAPSHOT_DIR = fileURLToPath(
  new URL('../../schema/protocol/', import.meta.url),
)

/**
 * A message of the attempt protocol (src/contract/attempt.ts), whose JSON Schema is generated
 * from its Zod schema alone: `root` names it in `ATTEMPT_SCHEMAS`.
 */
export type ProtocolShape = { name: string; root: string; where: string }

export const PROTOCOL_SHAPES: ProtocolShape[] = [
  {
    name: 'attempt-request',
    root: 'AttemptRequest',
    where: "A call an eval's body makes on its attempt, as a runner in another language sends it",
  },
  {
    name: 'attempt-reply',
    root: 'AttemptReply',
    where: "reeval's reply to an attempt request",
  },
  {
    name: 'attempt-start',
    root: 'AttemptStart',
    where: "reeval's message to a runner that starts an attempt's body",
  },
  {
    name: 'attempt-abort',
    root: 'AttemptAbort',
    where: "reeval's message to a runner when the attempt is aborted, as c.signal aborts",
  },
  {
    name: 'attempt-done',
    root: 'AttemptDone',
    where: "A runner's message when the eval's body has finished, with what it threw",
  },
]
