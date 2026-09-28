import { evaluate } from 'evalsuite'
import { goose } from 'evalsuite/harness'
import { docker } from 'evalsuite/sandbox'

evaluate('both harnesses', async () => {})
evaluate(
  'goose only, own id',
  { harness: goose({ model: 'gemini-3.8-pro', id: 'gs' }) },
  async () => {},
)
evaluate(
  'goose on a toolchain base, under deny-all',
  { sandbox: docker({ from: 'python:3.12-slim' }), egress: 'deny-all' },
  async () => {},
)
