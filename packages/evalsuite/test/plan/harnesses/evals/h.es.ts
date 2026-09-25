import { evaluate } from 'evalsuite'
import { claudeCode } from 'evalsuite/harness'
import { docker } from 'evalsuite/sandbox'

evaluate('both harnesses', async () => {})
evaluate(
  'claude only, own id',
  { harness: claudeCode({ model: 'opus', id: 'claude' }) },
  async () => {},
)
evaluate(
  'both harnesses on a dockerfile',
  { sandbox: docker({ dockerfile: '../docker/tools/Dockerfile' }) },
  async () => {},
)
evaluate(
  'claude on a toolchain base',
  {
    harness: claudeCode({ model: 'claude-sonnet-5' }),
    sandbox: docker({ from: 'python:3.12-slim' }),
  },
  async () => {},
)
