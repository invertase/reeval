import { evaluate, expect } from 'reeval'
import { patched } from './env.ts'

// files are written after the repository is copied in, so they win.
evaluate('lands', { environments: patched }, async (c) => {
  expect(await c.readFile('greet.js')).toContain('Howdy')
})
