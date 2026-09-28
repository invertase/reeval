import { evaluate, expect } from 'evalsuite'
import { patched } from './env.ts'

// files are written after the repository is copied in, so they win.
evaluate('lands', { environment: patched }, async (t) => {
  await t.sandbox()
  expect(await t.readFile('greet.js')).toContain('Howdy')
})
