import { defineEnvironment } from 'evalsuite'

export const houseRules = defineEnvironment('house-rules', {
  rules: 'The house rule word is MARMALADE.',
})

export const noRules = defineEnvironment('no-rules', {})

export const prompt =
  "Don't run any tools. What is the house rule word in your rules? Reply with the word only."
