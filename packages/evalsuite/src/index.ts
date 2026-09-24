// `evalsuite`: the core authoring API. Harnesses, sandboxes and judges live in subpaths.
export { defineConfig } from './config.ts'
export { expect } from './engine/runtime.ts'
export type { EvalOptions, GroupOptions } from './evaluate.ts'
export { evaluate, group } from './evaluate.ts'
export type { EvalEntry, RunRecord, TrialRecord } from './record/types.ts'
export type {
  ConfigContext,
  Diff,
  Duration,
  EsConfig,
  EvalContext,
  EvalFn,
  ExecResult,
  JudgeCallOptions,
  JudgeOptions,
  ResultsConfig,
  TranscriptEvent,
  Turn,
  Verdict,
} from './types.ts'
