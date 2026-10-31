import { defineConfig } from 'reeval'
import { goose } from 'reeval/harness'

// Real Goose only (O), with GOOGLE_GENERATIVE_AI_API_KEY: the eval's own Vertex AI-named
// variables reach the agent's shell as the eval set them, on a route that isn't Vertex AI.
export default defineConfig({
  harnesses: goose({ model: process.env.REEVAL_REAL_MODEL ?? 'gemini-3.8-flash' }),
})
