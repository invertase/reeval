import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

// A Dockerfile FROM ${REEVAL_BASE} under Grok Build is built on Grok Build's image, so its CLI is
// there, in the private home its bootstrap gives it.
evaluate('lands', { environment: plain }, async (c) => {
  const cli = await c.exec(
    'ls "$HOME"/.ai-sdk-harness/.harness-bootstrap/grok-build/implementation/home/.local/bin/grok',
  )
  expect(cli.stdout.trim()).toMatch(/\/grok$/)
})
