import { evaluate } from 'reeval'
import { opencode } from 'reeval/harness'
import { docker } from 'reeval/sandbox'

evaluate('both harnesses', async () => {})
evaluate(
  'opencode only, own id',
  { harness: opencode({ model: 'google/gemini-3.8-pro', id: 'oc' }) },
  async () => {},
)
evaluate(
  'opencode on a toolchain base, under deny-all',
  { sandbox: docker({ from: 'python:3.12-slim' }), egress: 'deny-all' },
  async () => {},
)
evaluate(
  'opencode on other providers, under deny-all: their hosts are the automatic ones',
  {
    harness: [
      opencode({ model: 'anthropic/claude-haiku-4-5' }),
      opencode({ model: 'openrouter/openai/gpt-5.4-mini', id: 'opencode:openrouter' }),
    ],
    egress: 'deny-all',
  },
  async () => {},
)
evaluate(
  'opencode on Bedrock, under deny-all: its region is its hosts',
  {
    harness: opencode({ model: 'amazon-bedrock/global.anthropic.claude-haiku-4-5' }),
    egress: 'deny-all',
  },
  async () => {},
)
