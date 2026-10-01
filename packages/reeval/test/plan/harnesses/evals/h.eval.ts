import { defineEnvironment, evaluate } from 'reeval'
import { claudeCode } from 'reeval/harness'
import { docker } from 'reeval/sandbox'

const tools = defineEnvironment('tools', {
  sandbox: docker({ dockerfile: '../docker/tools/Dockerfile' }),
})
const python = defineEnvironment('python', {
  sandbox: docker({ from: 'python:3.12-slim' }),
})

evaluate('both harnesses', async () => {})
evaluate(
  'claude only, own id',
  { harness: claudeCode({ model: 'opus', id: 'claude' }) },
  async () => {},
)
evaluate('both harnesses on a dockerfile', { environment: tools }, async () => {})
evaluate(
  'claude on a toolchain base',
  { harness: claudeCode({ model: 'claude-sonnet-5' }), environment: python },
  async () => {},
)
