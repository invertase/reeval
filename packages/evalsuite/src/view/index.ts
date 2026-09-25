// `evalsuite/view`: browser-safe data for the studio, and later the TUI. No `node:` imports.
export type {
  AttemptRecord,
  CellRecord,
  EvalEntry,
  FileRef,
  HistoryCell,
  HistoryEntry,
  JudgementRecord,
  RunRecord,
  StackSummary,
} from '../history/types.ts'
export type { Outcome, TranscriptEvent } from '../types.ts'
export * from './compare.ts'
export { runHeader } from './header.ts'
export * from './model.ts'
export * from './paths.ts'
