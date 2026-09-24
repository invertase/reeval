export interface StoreReader {
  /** Paths under `prefix`, relative to the store root, sorted. */
  list(prefix: string): Promise<string[]>
  get(path: string): Promise<Uint8Array | null>
}

/** Regenerates derived files (the index, the README) from a view that includes the new files. */
export type Derive = (view: StoreReader) => Promise<Map<string, Uint8Array>>

export type CommitChange = {
  /** Create-only: history is never rewritten through a commit. */
  files: Map<string, Uint8Array>
  derive: Derive
  message: string
}

export type CommitReport = {
  created: string[]
  existing: string[]
  /** 1 unless another publisher won a race and the commit was redone on top of theirs. */
  attempts: number
  /** False when every file already existed and the derived files didn't change. */
  changed: boolean
}

export interface ResultsStore extends StoreReader {
  /** Stable and secret-free, e.g. `{ kind: 'git-branch', branch: 'es-results', remote: '…' }`. */
  describe(): { kind: string } & Record<string, string>
  /** Brings the view up to date with its source (a git fetch). */
  refresh?(): Promise<void>
  /**
   * Adds immutable files and regenerates derived ones atomically. A file that exists with
   * identical bytes counts as existing; different bytes throw `ImmutableFileError`.
   * `derive` may be called more than once, each time against the latest state.
   */
  commit(change: CommitChange): Promise<CommitReport>
}

export class ImmutableFileError extends Error {
  override name = 'ImmutableFileError'
  readonly path: string
  constructor(path: string) {
    super(`${path} already exists in the results store with different content`)
    this.path = path
  }
}

export const sameBytes = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b))
