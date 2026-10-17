import { evaluate, expect } from 'reeval'
import { ui } from './env.ts'

evaluate('canary', { environment: ui }, async (c) => {
  const server = await c.serve('node server.mjs')
  const shot = await c.capture(server, {
    name: 'after-submit',
    instructions: ['Fill in the sign-in form and submit'],
  })
  // Wrong artifact name: the check must be able to fail.
  expect(shot.file.path).toBe('artifacts/wrong.png')
})
