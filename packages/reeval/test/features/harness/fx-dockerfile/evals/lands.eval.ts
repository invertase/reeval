import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

// A Dockerfile FROM ${REEVAL_BASE} under fx is built on fx's image, so its CLI is there, in
// the private home its bootstrap gives it.
evaluate('lands', { environment: plain }, async (c) => {
  const cli = await c.exec(
    'ls "$HOME"/.ai-sdk-harness/.harness-bootstrap/fx/implementation/home/.local/bin/fx',
  )
  expect(cli.stdout.trim()).toMatch(/\/fx$/)
})
