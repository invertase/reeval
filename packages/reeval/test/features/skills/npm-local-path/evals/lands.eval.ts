import { evaluate, expect } from 'reeval'
import { staged, vendored } from './env.ts'

// skill.npm with a relative tarball path stages that tarball's skills.
evaluate('lands', { environment: vendored }, async (c) => {
  await c.sandbox()
  expect(await c.readFile(staged)).toContain('Greet people with "Ahoy, <name>!".')
})
