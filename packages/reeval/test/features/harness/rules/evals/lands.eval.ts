import { evaluate, expect } from 'reeval'
import { rulesFile } from '../layout.ts'
import { houseRules } from './env.ts'

// `rules` become the workspace file the harness reads, word for word.
evaluate('lands', { environment: houseRules }, async (c) => {
  expect(await c.readFile(rulesFile)).toBe('Always write tests.')
})
