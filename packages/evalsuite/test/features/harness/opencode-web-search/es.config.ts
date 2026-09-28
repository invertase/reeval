import { defineConfig } from 'evalsuite'
import { opencode } from 'evalsuite/harness'
import { docker } from 'evalsuite/sandbox'

// Real OpenCode only (O), with GOOGLE_GENERATIVE_AI_API_KEY: the agent searches the web with its
// websearch tool, which the adapter points at Exa's hosted MCP server, keyless.
export default defineConfig({
  harness: opencode({ model: process.env.ES_REAL_MODEL ?? 'google/gemini-3.8-flash' }),
  sandbox: docker(),
})
