import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

// A Dockerfile FROM ${REEVAL_BASE} under OpenCode is built on OpenCode's image: its CLI is there, and
// it's OpenCode 2.
evaluate('lands', { environment: plain }, async (c) => {
  await c.sandbox()
  const cli = await c.exec(
    'ls "$HOME"/.ai-sdk-harness/.harness-bootstrap/opencode/implementation/node_modules/.bin/opencode',
  )
  expect(cli.stdout.trim()).toMatch(/\/opencode$/)
  const version = await c.exec(`'${cli.stdout.trim()}' --version`)
  expect(version.stdout.trim()).toMatch(/^opencode v2\./)
})
