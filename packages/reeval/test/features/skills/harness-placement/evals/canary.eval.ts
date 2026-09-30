import { evaluate, expect } from 'reeval'
import { greeting, prompt, shellOutput } from './env.ts'

// Must fail: a harness-placed skill isn't also written into the workspace.
evaluate('canary', { environment: greeting }, async (c) => {
  const turn = await c.send(prompt)
  expect(shellOutput(turn, 1)).toContain('Greet people with "Ahoy, <name>!".')
})
