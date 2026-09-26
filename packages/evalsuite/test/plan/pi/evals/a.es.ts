import { evaluate } from 'evalsuite'
import { pi } from 'evalsuite/harness'
import { docker } from 'evalsuite/sandbox'

evaluate('both harnesses', async () => {})
evaluate('pi only, own id', { harness: pi({ model: 'gemini-3.8-pro', id: 'pim' }) }, async () => {})
evaluate(
  'pi on a toolchain base, under deny-all',
  { sandbox: docker({ from: 'python:3.12-slim' }), egress: 'deny-all' },
  async () => {},
)
