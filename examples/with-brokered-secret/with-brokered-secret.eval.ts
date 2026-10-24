import { defineEnvironment, evaluate, expect } from 'reeval'

// The sandbox holds a placeholder. The egress gateway swaps in the real key only on HTTPS
// requests to Gemini's API, so the agent's code works and the key never enters the container.
const gemini = defineEnvironment('gemini', ({ secret }) => ({
  env: {
    GEMINI_API_KEY: secret.fromEnv('GOOGLE_GENERATIVE_AI_API_KEY', {
      hosts: secret.hosts.gemini,
    }),
  },
}))

evaluate('calls Gemini with a key it never sees', { environment: gemini }, async (c) => {
  await c.send(
    'Write models.js, a Node script that lists the Gemini API models with fetch and prints how ' +
      'many there are. Read the key from GEMINI_API_KEY and send it in the x-goog-api-key header.',
  )

  await expect(c.exec('node models.js')).toSucceed()
  expect((await c.exec('printenv GEMINI_API_KEY')).stdout).toMatch(/^reeval_secret_/)
})
