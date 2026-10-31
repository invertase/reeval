import { defineEnvironment, evaluate } from 'reeval'
import { antigravity, claudeCode, cursor } from 'reeval/harness'
import { docker } from 'reeval/sandbox'

const tools = defineEnvironment('tools', {
  sandbox: docker({ dockerfile: '../docker/tools/Dockerfile' }),
})
const python = defineEnvironment('python', {
  sandbox: docker({ from: 'python:3.12-slim' }),
})

evaluate('both harnesses', async () => {})
evaluate(
  'antigravity only, own id',
  { harnesses: antigravity({ model: 'gemini-3.8-flash-low', id: 'agy' }) },
  async () => {},
)
evaluate(
  'three harnesses on a dockerfile',
  {
    harnesses: (inherited) => [...inherited, claudeCode({ model: 'claude-sonnet-5' })],
    environments: tools,
  },
  async () => {},
)
evaluate(
  'antigravity on a toolchain base',
  {
    harnesses: [cursor({ model: 'composer-2.5' }), antigravity({ model: 'gemini-3.1-pro-high' })],
    environments: python,
  },
  async () => {},
)
