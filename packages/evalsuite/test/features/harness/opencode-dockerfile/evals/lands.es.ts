import { evaluate, expect } from 'evalsuite'
import { plain } from './env.ts'

// A Dockerfile FROM ${ES_BASE} under OpenCode is built on OpenCode's image: its CLI is there, and
// so is the plugin runtime the image bakes, which OpenCode would otherwise install on every start.
evaluate('lands', { environment: plain }, async (t) => {
  await t.sandbox()
  const cli = await t.exec(
    'ls "$HOME"/.ai-sdk-harness/.harness-bootstrap/opencode/implementation/node_modules/.bin/opencode',
  )
  expect(cli.stdout.trim()).toMatch(/\/opencode$/)
  const plugin = await t.exec('ls -d "$HOME"/.config/opencode/node_modules/@opencode-ai/plugin')
  expect(plugin.exitCode).toBe(0)
})
