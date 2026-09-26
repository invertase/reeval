import { evaluate, expect } from 'evalsuite'
import { plain } from './env.ts'

// Must fail: it isn't built on Cursor's image, so Cursor's agent CLI isn't there.
evaluate('canary', { environment: plain }, async (t) => {
  await t.sandbox()
  const found = await t.exec(
    'find "$HOME/.ai-sdk-harness" -name agent \\( -type f -o -type l \\) -perm -u+x | head -1',
  )
  expect(found.stdout.trim()).toMatch(/\/agent$/)
})
