import { evaluate, expect } from 'reeval'
import { greeting, staged } from './env.ts'

// skill.git without a path stages the skills under the repository's skills/ directory.
evaluate('lands', { environment: greeting }, async (c) => {
  expect(await c.readFile(staged)).toContain('Greet people with "Ahoy, <name>!".')
})
