import { defineEnvironment, evaluate } from 'reeval'
import { goose } from 'reeval/harness'
import { docker } from 'reeval/sandbox'

evaluate('both harnesses', async () => {})
evaluate(
  'goose only, own id',
  { harness: goose({ model: 'gemini-3.8-pro', id: 'gs' }) },
  async () => {},
)
evaluate(
  'goose on a toolchain base, under deny-all',
  {
    environment: defineEnvironment('python', {
      sandbox: docker({ from: 'python:3.12-slim' }),
    }),
    egress: 'deny-all',
  },
  async () => {},
)
