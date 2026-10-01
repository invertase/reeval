import { defineEnvironment, evaluate } from 'reeval'
import { docker } from 'reeval/sandbox'

const skilled = defineEnvironment('skilled', {
  sandbox: docker({ from: 'node:24-bookworm' }),
})

// No baseline: the config's `environment` is the control.
evaluate('config is the control', { compare: { variants: [skilled] } }, async () => {})
