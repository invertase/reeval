import { defineEnvironment, evaluate } from 'reeval'
import { grokBuild } from 'reeval/harness'
import { docker } from 'reeval/sandbox'

evaluate('both harnesses', async () => {})
evaluate(
  'grok build only, own id and effort',
  { harnesses: grokBuild({ model: 'grok-4.6', effort: 'high', id: 'gb' }) },
  async () => {},
)
evaluate(
  'grok build on a toolchain base, under deny-all',
  {
    environments: defineEnvironment('python', {
      sandbox: docker({ from: 'python:3.12-slim' }),
    }),
    egress: 'deny-all',
  },
  async () => {},
)
