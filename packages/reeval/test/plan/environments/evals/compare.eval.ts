import { defineEnvironment, evaluate } from 'reeval'
import { docker } from 'reeval/sandbox'

const plain = defineEnvironment('plain', { sandbox: docker({ from: 'node:22-bookworm' }) })
const skilled = defineEnvironment('skilled', {
  sandbox: docker({ from: 'node:24-bookworm' }),
})

// compare.control replaces the config's `environments`.
evaluate(
  'the control replaces the config environment',
  { compare: { control: plain, variants: [skilled] } },
  async () => {},
)
