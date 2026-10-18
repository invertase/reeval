import { defineEnvironment, evaluate } from 'reeval'

// Relative to this file, as docker() and fakeSandbox() would resolve them here.
const own = defineEnvironment('own', {
  sandbox: { kind: 'docker', dockerfile: './images/Dockerfile' },
})

evaluate('from the config', {}, async () => {})
evaluate('a literal environment', { environment: own }, async () => {})
evaluate(
  'a literal sandbox',
  { sandbox: { kind: 'docker', dockerfile: 'images/Dockerfile' } },
  async () => {},
)
