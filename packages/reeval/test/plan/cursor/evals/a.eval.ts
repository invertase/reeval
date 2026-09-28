import { evaluate } from 'reeval'
import { cursor } from 'reeval/harness'
import { docker } from 'reeval/sandbox'

evaluate('standard and fast', async () => {})
evaluate('another model', { harness: cursor({ model: 'gpt-5.2' }) }, async () => {})
evaluate(
  'on a toolchain base',
  { harness: cursor({ model: 'composer-2.5' }), sandbox: docker({ from: 'python:3.12-slim' }) },
  async () => {},
)
