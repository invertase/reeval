import { evaluate, expect } from 'reeval'
import { ui } from './env.ts'

evaluate('lands', { environment: ui }, async (c) => {
  await c.sandbox()
  const server = await c.serve('node server.mjs')
  const shot = await c.capture(server, {
    name: 'after-submit',
    instructions: ['Fill in the sign-in form and submit'],
  })
  expect(shot.file.path).toBe('artifacts/after-submit.png')
  expect(shot.name).toBe('after-submit')
})
