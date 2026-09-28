import { evaluate } from 'reeval'
import { docker } from 'reeval/sandbox'

evaluate('config sandbox with install', async () => {})
evaluate('same sandbox again', async () => {})
evaluate('toolchain base', { sandbox: docker({ from: 'python:3.12-slim' }) }, async () => {})
evaluate(
  'own dockerfile',
  { sandbox: docker({ dockerfile: '../docker/Dockerfile' }) },
  async () => {},
)
