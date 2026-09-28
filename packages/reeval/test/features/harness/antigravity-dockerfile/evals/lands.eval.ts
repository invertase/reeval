import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

// A Dockerfile FROM ${REEVAL_BASE} under Antigravity is built on Antigravity's image, so the agy CLI is there.
evaluate('lands', { environment: plain }, async (t) => {
  await t.sandbox()
  const found = await t.exec(
    'find "$HOME/.ai-sdk-harness" -name agy \\( -type f -o -type l \\) -perm -u+x | head -1',
  )
  expect(found.stdout.trim()).toMatch(/\/agy$/)
})
