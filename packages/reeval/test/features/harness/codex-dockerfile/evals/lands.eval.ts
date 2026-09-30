import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

// A Dockerfile FROM ${REEVAL_BASE} under Codex is built on Codex's image, so its CLI is there.
evaluate('lands', { environment: plain }, async (c) => {
  await c.sandbox()
  const cli = await c.exec('ls "$HOME"/.ai-sdk-harness/.harness-bootstrap/codex/bin/codex')
  expect(cli.stdout.trim()).toMatch(/\/codex$/)
})
