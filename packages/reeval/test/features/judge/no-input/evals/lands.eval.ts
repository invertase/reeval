import { evaluate, expect } from 'reeval'
import type { JudgeCallOptions } from 'reeval/judge'
import { fakeJudge } from 'reeval/judge'
import { app } from './env.ts'

// A call that turns no input on, as JavaScript or a cast lets through, fails before any model
// call, naming the inputs.
evaluate('lands', { environments: app }, async (c) => {
  await c.send('write the app')
  let asked = false
  const look = fakeJudge({
    score: () => {
      asked = true
      return 1
    },
  })
  const nothing = { model: look, threshold: 0.5, diff: false } as unknown as JudgeCallOptions
  await expect(c.judge('Is there a sign up flow?', nothing)).rejects.toThrow(
    'c.judge() shows the judge nothing: turn on at least one input, such as { diff: true } or ' +
      "{ contents: ['src/**'] }. The inputs are task, output, files, diff, contents, transcript, " +
      'checks, observations or artifacts.',
  )
  expect(asked).toBe(false)
})
