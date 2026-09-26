import { evaluate } from 'evalsuite'
import { opencode } from 'evalsuite/harness'
import { docker } from 'evalsuite/sandbox'

evaluate('both harnesses', async () => {})
evaluate(
  'opencode only, own id',
  { harness: opencode({ model: 'gemini-3.8-pro', id: 'oc' }) },
  async () => {},
)
evaluate(
  'opencode on a toolchain base, under deny-all',
  { sandbox: docker({ from: 'python:3.12-slim' }), egress: 'deny-all' },
  async () => {},
)
