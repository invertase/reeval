// The manifest of a history archive: `reeval-archive.json` in `<runId>.zip`. Browser-safe.

/** One file in an archive, by its path from the archive's root. */
export type ArchiveFile = {
  /** Relative to the archive's root, with `/`: `<runId>.json` or under `<runId>/`. */
  path: string
  /** sha256 of its bytes, uncompressed. */
  sha256: string
  /** Its size in bytes, uncompressed. */
  bytes: number
}

/**
 * The manifest of a history archive: a zip of one recorded run, laid out as the run is in a
 * history folder. A `run` archive holds the record, `<runId>.json`, and the files beside it under
 * `<runId>/`; a `debug` archive holds the run's debug data under `<runId>/`, as
 * `.reeval/debug/<runId>/` keeps it. The manifest is the zip's last entry and lists every other.
 */
export type ArchiveManifest = {
  kind: 'reeval-archive'
  schemaVersion: 1
  /** What the archive holds: the recorded run, or its debug data. */
  contents: 'run' | 'debug'
  /** The run's id, which names the archive, `<runId>.zip`, and its record. */
  runId: string
  /** 1 for a run's first archive, one more each time the run's archive is written again. */
  revision: number
  /** The reeval that wrote it. */
  reeval: string
  /** When it was written, ISO 8601. */
  createdAt: string
  /** Of a `debug` archive: which of each attempt's debug files it holds, as `history.debug` names them. */
  debugLevel?: 'requests' | 'all'
  /** Every other entry, sorted by path. */
  files: ArchiveFile[]
}
