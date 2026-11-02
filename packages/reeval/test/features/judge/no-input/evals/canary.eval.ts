import { evaluate, expect } from 'reeval'
import type { JudgeCallOptions } from 'reeval/judge'
import { fakeJudge } from 'reeval/judge'
import { app } from './env.ts'

// Must fail: a call with only judge settings has no default inputs to fall back on.
evaluate('canary', { environments: app }, async (c) => {
  await c.send('write the app')
  const nothing = { model: fakeJudge({ score: 1 }) } as unknown as JudgeCallOptions
  let error: unknown
  await c.judge('Is there a sign up flow?', nothing).catch((e: unknown) => {
    error = e
  })
  expect(() => {
    if (error) throw error
  }).not.toThrow()
})
