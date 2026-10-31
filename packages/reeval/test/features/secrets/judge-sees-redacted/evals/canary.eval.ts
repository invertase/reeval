import { evaluate, expect } from 'reeval'
import { judgeSaw, tokens } from './env.ts'

// Must fail: the judge isn't sent the check's real output.
evaluate('canary', { environments: tokens }, async (c) => {
  const state = await judgeSaw(c, 'canary')
  expect(state.checks?.[0]?.stdout).toBe(process.env.REEVAL_FIXTURE_TOKEN)
})
