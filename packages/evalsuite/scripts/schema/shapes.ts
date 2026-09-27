import { fileURLToPath } from 'node:url'
import type { ShapeName } from '../../src/view/record.ts'

export const PACKAGE_DIR = fileURLToPath(new URL('../../', import.meta.url))
/** Where the committed snapshots live, one `<name>.schema.json` per shape. */
export const SNAPSHOT_DIR = fileURLToPath(new URL('../../schema/', import.meta.url))

/**
 * A shape ES writes to disk and reads back later, perhaps from an older or newer ES. Caches that
 * ES rebuilds when its version changes (`.es/history-cache.json`, `.es/history.db`) aren't here.
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
    where: 'A run record: evals/.history/<run>.json and .es/runs/<run>.json',
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
    where: 'An es analyze document: <run>/analysis/*.json and .es/analysis/<key>.json',
    versionField: 'schemaVersion',
  },
  {
    name: 'debug-request',
    file: 'src/view/debug.ts',
    type: 'DebugRequest',
    where: "One line of an attempt's .es/debug/…/requests.ndjson",
  },
  {
    name: 'live-progress',
    file: 'src/view/live.ts',
    type: 'LiveProgress',
    where: "A running es run's progress: .es/staging/<run>/live.json, read by es studio",
    versionField: 'schemaVersion',
  },
  {
    name: 'cli-invocation',
    file: 'src/report/types.ts',
    type: 'CliInvocation',
    where: 'One line of .es/cli.jsonl, the last es commands es report reads',
  },
]
