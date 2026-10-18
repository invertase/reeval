import { defineEnvironment, evaluate } from 'reeval'
import { fx } from 'reeval/harness'
import { docker } from 'reeval/sandbox'

evaluate('both harnesses', async () => {})
evaluate(
  'fx on OpenAI, own id',
  { harness: fx({ model: 'gpt-4.1-mini', id: 'fx-openai' }) },
  async () => {},
)
evaluate(
  'fx on a toolchain base, under deny-all',
  {
    environment: defineEnvironment('python', {
      sandbox: docker({ from: 'python:3.12-slim' }),
    }),
    egress: 'deny-all',
  },
  async () => {},
)
