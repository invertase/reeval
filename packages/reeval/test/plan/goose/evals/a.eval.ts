import { defineEnvironment, evaluate } from 'reeval'
import { goose } from 'reeval/harness'
import { docker } from 'reeval/sandbox'

evaluate('both harnesses', async () => {})
evaluate(
  'goose only, own id',
  { harnesses: goose({ model: 'google/gemini-3.8-pro', id: 'gs' }) },
  async () => {},
)
evaluate(
  'goose on a toolchain base, under deny-all',
  {
    environments: defineEnvironment('python', {
      sandbox: docker({ from: 'python:3.12-slim' }),
    }),
    egress: 'deny-all',
  },
  async () => {},
)
evaluate(
  'goose on other providers, under deny-all: their hosts are the automatic ones',
  {
    harnesses: [
      goose({ model: 'anthropic/claude-haiku-4-5' }),
      goose({ model: 'openai/gpt-5.4-mini' }),
      goose({ model: 'xai/grok-4.6' }),
      goose({ model: 'google/gemini-3.8-flash', id: 'goose:google' }),
    ],
    egress: 'deny-all',
  },
  async () => {},
)
