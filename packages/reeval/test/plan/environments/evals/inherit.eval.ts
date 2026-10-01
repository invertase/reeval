import { defineEnvironment, evaluate } from 'reeval'

const plain = defineEnvironment('plain', {})
const withMode = defineEnvironment('with-mode', { env: { MODE: 'x' } })

// Named compare arms omit sandbox: they inherit the config environment's image.
evaluate(
  'named compare inherits the config sandbox',
  { compare: { baseline: plain, variants: [withMode] } },
  async () => {},
)
