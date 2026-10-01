import { defineConfig } from 'reeval'
import { cursor } from 'reeval/harness'

// Real Cursor only (C), with CURSOR_API_KEY: whether the agent reads rules is up to the agent.
// Where reeval writes them is harness/cursor-rules, on the fake and Docker tiers.
export default defineConfig({
  harness: cursor({ model: process.env.REEVAL_REAL_MODEL ?? 'composer-2.5' }),
})
