// `evalsuite`: the core authoring API. Harnesses, sandboxes and judges live in subpaths.
export { defineConfig } from './config.ts'
export { expect } from './engine/runtime.ts'
export type { EvalOptions, GroupOptions } from './evaluate.ts'
export { evaluate, group } from './evaluate.ts'
export type { AttemptRecord, EvalEntry, RunRecord } from './history/types.ts'
export type {
  ConfigContext,
  Diff,
  Duration,
  EsConfig,
  EvalContext,
  EvalFn,
  ExecResult,
  HistoryConfig,
  JudgeCallOptions,
  JudgeOptions,
  TranscriptEvent,
  Turn,
  Verdict,
} from './types.ts'
