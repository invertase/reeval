// Runs coding-agent harnesses on a runner and records what they did. It knows nothing of evals
// or of where it runs: test/boundary.test.ts holds both.
export { type LocalOptions, local } from './local.ts'
export type { Proc, ProcExit, Runner, RunnerInfo, SpawnOptions } from './runner.ts'
export { withFallbacks } from './runner.ts'
export { type RunnerSessionOptions, runnerSession } from './runner-session.ts'
