import { defineConfig } from 'reeval'
import { codex } from 'reeval/harness'

// Real Codex only (C), with OPENAI_API_KEY: the agent searches the web with its web search tool,
// which Codex runs itself on POST api.openai.com/v1/alpha/search with the brokered key.
export default defineConfig({
  harness: codex({ model: process.env.REEVAL_REAL_MODEL ?? 'gpt-5.6-luna' }),
})
