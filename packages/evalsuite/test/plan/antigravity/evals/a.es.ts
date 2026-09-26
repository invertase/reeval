import { evaluate } from 'evalsuite'
import { antigravity, claudeCode, cursor } from 'evalsuite/harness'
import { docker } from 'evalsuite/sandbox'

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
    harness: [cursor(), antigravity({ model: 'gemini-3.1-pro-high' })],
    sandbox: docker({ from: 'python:3.12-slim' }),
  },
  async () => {},
)
