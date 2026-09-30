import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

// A Dockerfile FROM ${REEVAL_BASE} under pi is built on pi's image, so its CLI is there.
evaluate('lands', { environment: plain }, async (c) => {
  await c.sandbox()
  const cli = await c.exec('ls "$HOME"/.ai-sdk-harness/.harness-bootstrap/pi/node_modules/.bin/pi')
  expect(cli.stdout.trim()).toMatch(/\/pi$/)
})
