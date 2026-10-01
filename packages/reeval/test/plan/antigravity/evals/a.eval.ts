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
  { harness: antigravity({ model: 'gemini-3.8-flash-low', id: 'agy' }) },
  async () => {},
)
evaluate(
  'three harnesses on a dockerfile',
  {
    harness: (inherited) => [...inherited, claudeCode({ model: 'claude-sonnet-5' })],
    environment: tools,
  },
  async () => {},
)
evaluate(
  'antigravity on a toolchain base',
  {
    harness: [cursor({ model: 'composer-2.5' }), antigravity({ model: 'gemini-3.1-pro-high' })],
    environment: python,
  },
  async () => {},
)
