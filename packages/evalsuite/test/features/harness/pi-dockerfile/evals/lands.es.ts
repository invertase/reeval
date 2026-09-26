import { evaluate, expect } from 'evalsuite'
import { plain } from './env.ts'

// A Dockerfile FROM ${ES_BASE} under pi is built on pi's image, so its CLI is there.
evaluate('lands', { environment: plain }, async (t) => {
  await t.sandbox()
  const cli = await t.exec('ls "$HOME"/.ai-sdk-harness/.harness-bootstrap/pi/node_modules/.bin/pi')
  expect(cli.stdout.trim()).toMatch(/\/pi$/)
})
