import { evaluate, expect } from 'reeval'
import { otherFile } from '../layout.ts'
import { houseRules } from './env.ts'

// Must fail: the rules go to the harness's own file only, not the other agents'.
evaluate('canary', { environment: houseRules }, async (c) => {
  expect(await c.readFile(otherFile)).toBe('Always write tests.')
})
