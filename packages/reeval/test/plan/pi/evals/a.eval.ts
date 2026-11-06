import { defineEnvironment, evaluate } from 'reeval'
import { pi } from 'reeval/harness'
import { docker } from 'reeval/sandbox'

evaluate('both harnesses', async () => {})
evaluate(
  'pi only, own id',
  { harnesses: pi({ model: 'google/gemini-3.8-pro', id: 'pim' }) },
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
evaluate(
  'pi on other providers, under deny-all: their hosts are the automatic ones',
  {
    harnesses: [
      pi({ model: 'anthropic/claude-haiku-4-5' }),
      pi({ model: 'openai/gpt-5.4-mini' }),
      pi({ model: 'xai/grok-4.6' }),
      pi({ model: 'mistral/devstral-2' }),
      pi({ model: 'huggingface/Qwen/Qwen3-Coder-480B-A35B-Instruct' }),
      pi({ model: 'google/gemini-3.8-flash', id: 'pi:google' }),
    ],
    egress: 'deny-all',
  },
  async () => {},
)
