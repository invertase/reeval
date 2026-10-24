// reeval.config.ts with an analysis model: each run ends with its insights (what each eval asks and
// its answer) on google/gemini-3.8-flash (GOOGLE_GENERATIVE_AI_API_KEY), which also answers the
// compare questions. `reeval run --config reeval.analysis.config.ts --profile questions` is the
// nightly analyst check (test/questions-real.test.ts), so only that leg pays for the analyst.
import { defineConfig } from 'reeval'
import config from './reeval.config.ts'

export default defineConfig({
  ...config,
  analysis: { model: 'google/gemini-3.8-flash' },
})
