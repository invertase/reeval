import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

export const houseRules = defineEnvironment('house-rules', {
  sandbox,
  rules: 'The house rule word is MARMALADE.',
})

export const noRules = defineEnvironment('no-rules', { sandbox })

export const prompt =
  "Don't run any tools. What is the house rule word in your rules? Reply with the word only."
