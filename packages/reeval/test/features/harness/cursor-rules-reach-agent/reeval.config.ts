import { defineConfig } from 'evalsuite'
import { cursor } from 'evalsuite/harness'
import { docker } from 'evalsuite/sandbox'

// Real Cursor only (C), with CURSOR_API_KEY: whether the agent reads rules is up to the agent.
// Where ES writes them is harness/cursor-rules, on the fake and Docker tiers.
export default defineConfig({
  harness: cursor({ model: process.env.ES_REAL_MODEL ?? 'composer-2.5' }),
  sandbox: docker(),
})
