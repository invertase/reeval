import { evaluate, expect } from 'evalsuite'
import { plain } from './env.ts'

// A Dockerfile FROM ${ES_BASE} under Claude Code is built on Claude Code's image, so the claude CLI is there.
evaluate('lands', { environment: plain }, async (t) => {
  await t.sandbox()
  const found = await t.exec(
    'find "$HOME/.ai-sdk-harness" -name claude \\( -type f -o -type l \\) -perm -u+x | head -1',
  )
  expect(found.stdout.trim()).toMatch(/\/claude$/)
})
