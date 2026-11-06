// A run's event stream, as `reeval run --events` writes it and `reeval attach` reads it back: NDJSON,
// one `RunEventLine` per line. A run starts with a header line and ends with an exit line; a
// resume of the run appends its own header, events and exit line to the same stream. Browser-safe.

import type { ReevalEvent } from '../ui/events.ts'
import { fillDefaults, NewerSchemaError, SCHEMA_VERSIONS } from './record.ts'

export const EVENTS_SCHEMA_VERSION = 1

/** The first line a `reeval run` writes to the stream: what the renderers need to draw it. */
export type RunEventsHeader = {
  type: 'header'
  schemaVersion: 1
  /** The reeval that wrote the stream. */
  reeval: string
  runId: string
  /** When this `reeval run` (the run, or a resume of it) started, as ISO 8601. */
  startedAt: string
  /** The `reeval run` process and its host, so a reader can tell a run that died. */
  pid: number
  host: string
  /** The config's first harness kind, which names attempts' axes on detail lines. */
  harness: string
  /** `-v` (1) or `-vv` (2): how debug lines' times read; 0 without either. */
  verbosity: 0 | 1 | 2
  /**
   * How often a quiet stream gets a heartbeat line, so a reader can treat silence as a stall from
   * the header on. Absent from streams that write none, such as an older reeval's.
   */
  heartbeatMs?: number
}

/** The last line a `reeval run` writes to the stream: its exit code. */
export type RunEventsExit = {
  type: 'exit'
  at: number
  code: number
}

/**
 * Written while the stream is otherwise quiet, so a reader can tell a run that's still going from
 * one that stalled or was lost. Streams from before it have none.
 */
export type RunEventsHeartbeat = {
  type: 'heartbeat'
  at: number
}

/** One line of a run's event stream. */
export type RunEventLine = RunEventsHeader | ReevalEvent | RunEventsHeartbeat | RunEventsExit

/**
 * A stream line as `reeval attach` reads it. A header from a newer reeval throws a
 * `NewerSchemaError`; an event type this reeval doesn't know is passed on, and the renderers
 * ignore it.
 */
export function readableEventLine(line: RunEventLine): RunEventLine {
  if (line.type === 'header') {
    const newest = SCHEMA_VERSIONS['run-events']
    if (line.schemaVersion > newest) {
      throw new NewerSchemaError(`run ${line.runId}'s event stream`, line.schemaVersion, newest)
    }
  }
  return fillDefaults('run-events', line)
}
