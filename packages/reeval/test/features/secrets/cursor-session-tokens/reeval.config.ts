import { defineConfig } from 'reeval'
import { cursor } from 'reeval/harness'

// Real Cursor only (C), with CURSOR_API_KEY: the tokens come from Cursor's own exchange. The
// gateway side is covered without a key in sandbox-docker's proxy and Docker tests.
export default defineConfig({
  harnesses: cursor({ model: process.env.REEVAL_REAL_MODEL ?? 'composer-2.5' }),
})
