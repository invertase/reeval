import { defineEnvironment } from 'reeval'
import { docker } from 'reeval/sandbox'

/** Empty control for the house-greeting compare. */
export const plain = defineEnvironment('plain', {})

/** The house-greeting skill, layered on `plain` before compare runs the two apart. */
export const withHouseGreeting = plain.extendEnvironment('with-house-greeting', ({ skill }) => ({
  skills: [skill.local('../skills/house-greeting')],
}))

/**
 * What the Genkit evals need to run at all: the key the app the agent builds calls Gemini with.
 * Brokered: the sandbox holds a placeholder, which the gateway swaps for the key only on
 * HTTPS requests to Gemini's API.
 */
export const genkit = defineEnvironment('genkit', ({ secret }) => ({
  env: {
    GOOGLE_GENAI_API_KEY: secret.fromEnv('GOOGLE_GENERATIVE_AI_API_KEY', {
      hosts: secret.hosts.gemini,
    }),
    GEMINI_API_KEY: secret.fromEnv('GOOGLE_GENERATIVE_AI_API_KEY', { hosts: secret.hosts.gemini }),
  },
}))

/** Official Python image; reeval bakes Node and the harness on the first run. */
export const python = defineEnvironment('python', {
  sandbox: docker({ from: 'python:3.12-slim', id: 'python' }),
})

/** A Dockerfile, relative to this file. */
export const sqlite = defineEnvironment('sqlite', {
  sandbox: docker({ dockerfile: '../docker/sqlite/Dockerfile' }),
})

/** Extra tools baked onto reeval's image once and cached by the command list. */
export const jq = defineEnvironment('jq', {
  sandbox: docker({
    install: [
      'apt-get update && apt-get install -y --no-install-recommends jq && rm -rf /var/lib/apt/lists/*',
    ],
  }),
})
