// The main config with analysis.agent on: a note on each eval and harness after its attempts, and a
// summary of the run once it's written, on google/gemini-3.8-flash (GOOGLE_GENERATIVE_AI_API_KEY).
// `reeval run --config reeval.analysis.config.ts --profile questions` is the nightly analyst check
// (test/questions-real.test.ts), so only that leg pays for the analyst.
import { defineConfig } from 'reeval'
import config from './reeval.config.ts'

export default defineConfig({
  ...config,
  analysis: { model: 'google/gemini-3.8-flash', agent: true },
})
