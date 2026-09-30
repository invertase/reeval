import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

// A Dockerfile FROM ${REEVAL_BASE} under Goose is built on Goose's image, so its CLI is there, in
// the private home its bootstrap gives it.
evaluate('lands', { environment: plain }, async (c) => {
  await c.sandbox()
  const cli = await c.exec(
    'ls "$HOME"/.ai-sdk-harness/.harness-bootstrap/goose/implementation/home/.local/bin/goose',
  )
  expect(cli.stdout.trim()).toMatch(/\/goose$/)
})
