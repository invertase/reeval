// `evalsuite/store`: where run history lives beyond `.es/`. Set `results.store` in es.config.ts.
export type {
  FileRef,
  IndexEntry,
  RunIndex,
  RunRecord,
  TrialRecord,
} from './record/types.ts'
export { type GitBranchStoreOptions, gitBranchStore } from './store/git.ts'
export { type LocalStoreOptions, localStore } from './store/local.ts'
export type {
  CommitChange,
  CommitReport,
  Derive,
  ResultsStore,
  StoreReader,
} from './store/types.ts'
export { ImmutableFileError } from './store/types.ts'
