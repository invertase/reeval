import { defineEnvironment } from 'evalsuite'

/** The house-greeting skill, handed to the agent through its harness's native skills support. */
export const withHouseGreeting = defineEnvironment('with-house-greeting', ({ skill }) => ({
  skills: [skill.local('../skills/house-greeting')],
}))

/** What the Genkit evals need to run at all: the key the app the agent builds calls Gemini with. */
export const genkit = defineEnvironment('genkit', ({ secret }) => ({
  env: {
    GOOGLE_GENAI_API_KEY: secret.fromEnv('GOOGLE_GENERATIVE_AI_API_KEY'),
    GEMINI_API_KEY: secret.fromEnv('GOOGLE_GENERATIVE_AI_API_KEY'),
  },
}))
