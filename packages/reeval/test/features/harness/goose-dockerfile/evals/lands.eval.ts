import { evaluate, expect } from 'evalsuite'
import { plain } from './env.ts'

// A Dockerfile FROM ${ES_BASE} under Goose is built on Goose's image, so its CLI is there, in
// the private home its bootstrap gives it.
evaluate('lands', { environment: plain }, async (t) => {
  await t.sandbox()
  const cli = await t.exec(
    'ls "$HOME"/.ai-sdk-harness/.harness-bootstrap/goose/implementation/home/.local/bin/goose',
  )
  expect(cli.stdout.trim()).toMatch(/\/goose$/)
})
