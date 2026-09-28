import { evaluate, expect } from 'reeval'
import { picked } from './env.ts'

// Must fail: with a name that is there, only that skill is staged, not its sibling.
evaluate('canary', { environment: picked }, async (t) => {
  await t.sandbox()
  const staged = (await t.exec('ls .agents/skills')).stdout.trim().split('\n')
  expect(staged).toEqual(['house-farewell', 'house-greeting'])
})
