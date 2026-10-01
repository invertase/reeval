import { defineConfig } from 'reeval'
import { cursor } from 'reeval/harness'

// Real Cursor only (C), with CURSOR_API_KEY: the agent fetches a page with its web tool, and the
// transcript has the fetch, though SDK 1.0.32 leaves it out of its stream.
export default defineConfig({
  harness: cursor({
    model: process.env.REEVAL_REAL_MODEL ?? 'composer-2.5',
    params: { fast: 'false' },
  }),
})
