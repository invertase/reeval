import { defineEnvironment, evaluate } from 'reeval'
import { cursor } from 'reeval/harness'
import { docker } from 'reeval/sandbox'

const python = defineEnvironment('python', {
  sandbox: docker({ from: 'python:3.12-slim' }),
})

evaluate('standard and fast', async () => {})
evaluate('another model', { harnesses: cursor({ model: 'gpt-5.2' }) }, async () => {})
evaluate(
  'on a toolchain base',
  { harnesses: cursor({ model: 'composer-2.5' }), environments: python },
  async () => {},
)
