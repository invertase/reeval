import { defineEnvironment, evaluate } from 'reeval'
import { docker } from 'reeval/sandbox'

const skilled = defineEnvironment('skilled', {
  sandbox: docker({ from: 'node:24-bookworm' }),
})

// No baseline and no config environments: empty control, same image as the variant.
evaluate(
  'empty control shares the variant image',
  { compare: { variants: [skilled] } },
  async () => {},
)
