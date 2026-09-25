import { evaluate, expect } from 'evalsuite'
import { pinned, staged } from './env.ts'

// skill.git at a tag stages the skill as it was at that tag, not the branch head.
evaluate('lands', { environment: pinned }, async (t) => {
  await t.send('noop')
  expect(await t.readFile(staged)).toContain('Greet people with "Ahoy, <name>!".')
})
