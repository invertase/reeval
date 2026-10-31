import { defineEnvironment, evaluate } from 'reeval'
import { pi } from 'reeval/harness'
import { docker } from 'reeval/sandbox'

evaluate('both harnesses', async () => {})
evaluate(
  'pi only, own id',
  { harnesses: pi({ model: 'gemini-3.8-pro', id: 'pim' }) },
  async () => {},
)
evaluate(
  'pi on a toolchain base, under deny-all',
  {
    environments: defineEnvironment('python', {
      sandbox: docker({ from: 'python:3.12-slim' }),
    }),
    egress: 'deny-all',
  },
  async () => {},
)
