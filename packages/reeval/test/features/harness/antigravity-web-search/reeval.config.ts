import { defineConfig } from 'reeval'
import { antigravity } from 'reeval/harness'

// Real Antigravity only (A), with GEMINI_API_KEY: the agent searches the web with its search_web
// tool, which the CLI runs itself on POST generativelanguage.googleapis.com/v1beta/models/
// <lite model>:generateContent with the brokered key.
export default defineConfig({
  harness: antigravity({ model: process.env.REEVAL_REAL_MODEL ?? 'gemini-3.8-flash-low' }),
})
