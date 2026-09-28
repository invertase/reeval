import { evaluate } from 'reeval'
import { codex } from 'reeval/harness'
import { docker } from 'reeval/sandbox'

evaluate('both harnesses', async () => {})
evaluate('Codex only, own id', { harness: codex({ model: 'gpt-5.5', id: 'cx' }) }, async () => {})
evaluate(
  'Codex on a toolchain base, under deny-all',
  { sandbox: docker({ from: 'python:3.12-slim' }), egress: 'deny-all' },
  async () => {},
)
