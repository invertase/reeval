import { evaluate, expect } from 'reeval'
import { patched } from './env.ts'

// files are written after the repository is copied in, so they win.
evaluate('lands', { environment: patched }, async (c) => {
  await c.sandbox()
  expect(await c.readFile('greet.js')).toContain('Howdy')
})
