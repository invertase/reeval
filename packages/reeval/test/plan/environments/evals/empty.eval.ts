import { defineEnvironment, evaluate } from 'reeval'
import { docker } from 'reeval/sandbox'

const bare = defineEnvironment('bare', {})
const skilled = defineEnvironment('skilled', {
  sandbox: docker({ from: 'node:24-bookworm' }),
})

// An empty control runs on the cascaded sandbox, not on its variant's.
evaluate(
  'an empty control takes the cascaded sandbox',
  { compare: { control: bare, variants: [skilled] } },
  async () => {},
)
