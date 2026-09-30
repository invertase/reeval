import { evaluate, expect } from 'reeval'
import { pinned, staged } from './env.ts'

// skill.git at a tag stages the skill as it was at that tag, not the branch head.
evaluate('lands', { environment: pinned }, async (c) => {
  await c.sandbox()
  expect(await c.readFile(staged)).toContain('Greet people with "Ahoy, <name>!".')
})
