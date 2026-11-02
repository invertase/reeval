import { defineConfig } from 'reeval'
import { cursor } from 'reeval/harness'

// Real Cursor only (C), with CURSOR_API_KEY: the SDK reports each turn's tokens and the model it
// resolved, and reeval records both.
export default defineConfig({
  harnesses: cursor({
    model: process.env.REEVAL_REAL_MODEL ?? 'composer-2.5',
    params: { fast: 'false' },
  }),
})
