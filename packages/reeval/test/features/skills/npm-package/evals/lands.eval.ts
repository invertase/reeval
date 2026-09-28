import { evaluate, expect } from 'evalsuite'
import { pinned, staged } from './env.ts'

// skill.npm at a pinned version stages the skills/ directory of that version's tarball, not
// the latest one.
evaluate('lands', { environment: pinned }, async (t) => {
  await t.sandbox()
  expect(await t.readFile(staged)).toContain('Greet people with "Ahoy, <name>!".')
})
