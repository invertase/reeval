import { fakeHarness } from 'reeval/harness'

const usage = { input: 1000, output: 500, cacheRead: 2000, cacheWrite: 0, reasoning: null }

/** Says what each turn cost, as Claude Code and pi do. */
export const reporter = fakeHarness({ id: 'reporter', usage, costUsd: 0.25 })
/** Says only its tokens and model, which models.dev lists. */
export const listed = fakeHarness({ id: 'listed', usage, servedModel: 'claude-sonnet-5' })
/** Says its tokens and a model models.dev doesn't list. */
export const unknown = fakeHarness({ id: 'unknown', usage, servedModel: 'composer-2.5' })
/** Says nothing about tokens or cost. */
export const silent = fakeHarness({ id: 'silent' })
