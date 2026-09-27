import { evaluate, expect } from 'evalsuite'
import { plain } from './env.ts'

// A Dockerfile FROM ${ES_BASE} under Codex is built on Codex's image, so its CLI is there.
evaluate('lands', { environment: plain }, async (t) => {
  await t.sandbox()
  const cli = await t.exec('ls "$HOME"/.ai-sdk-harness/.harness-bootstrap/codex/bin/codex')
  expect(cli.stdout.trim()).toMatch(/\/codex$/)
})
