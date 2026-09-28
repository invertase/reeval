import { evaluate } from 'reeval'
import { antigravity, claudeCode, cursor } from 'reeval/harness'
import { docker } from 'reeval/sandbox'

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
    sandbox: docker({ dockerfile: '../docker/tools/Dockerfile' }),
  },
  async () => {},
)
evaluate(
  'antigravity on a toolchain base',
  {
    harness: [cursor({ model: 'composer-2.5' }), antigravity({ model: 'gemini-3.1-pro-high' })],
    sandbox: docker({ from: 'python:3.12-slim' }),
  },
  async () => {},
)
