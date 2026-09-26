import { evaluate } from 'evalsuite'
import { cursor } from 'evalsuite/harness'
import { docker } from 'evalsuite/sandbox'

evaluate('standard and fast', async () => {})
evaluate('another model', { harness: cursor({ model: 'gpt-5.2' }) }, async () => {})
evaluate(
  'on a toolchain base',
  { harness: cursor({ model: 'composer-2.5' }), sandbox: docker({ from: 'python:3.12-slim' }) },
  async () => {},
)
