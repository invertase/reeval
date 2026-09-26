import { evaluate, expect } from 'evalsuite'
import { pinned, staged } from './env.ts'

// skill.registry('owner/repo@skill', { version }) stages that one skill from the repository's
// skills/ directory as it was at the version, not the branch head.
evaluate('lands', { environment: pinned }, async (t) => {
  await t.sandbox()
  expect(await t.readFile(staged)).toContain('Greet people with "Ahoy, <name>!".')
})
