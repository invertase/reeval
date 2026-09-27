import { evaluate, expect } from 'evalsuite'
import { plain } from './env.ts'

// A Dockerfile FROM ${ES_BASE} under OpenCode is built on OpenCode's image: its CLI is there, and
// it's OpenCode 2.
evaluate('lands', { environment: plain }, async (t) => {
  await t.sandbox()
  const cli = await t.exec(
    'ls "$HOME"/.ai-sdk-harness/.harness-bootstrap/opencode/implementation/node_modules/.bin/opencode',
  )
  expect(cli.stdout.trim()).toMatch(/\/opencode$/)
  const version = await t.exec(`'${cli.stdout.trim()}' --version`)
  expect(version.stdout.trim()).toMatch(/^opencode v2\./)
})
