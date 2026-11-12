import { defineConfig } from 'reeval'
import { fx } from 'reeval/harness'

// Real fx only (O), with OPENAI_API_KEY: fx starts a stdio MCP server with none of the sandbox's
// variables but its own, so the adapter lists them in the server's env. REEVAL_EGRESS_TARGET is a
// listener on the host that features.test.ts starts, at a non-loopback address.
export default defineConfig({
  harnesses: fx({ model: process.env.REEVAL_REAL_MODEL ?? 'gpt-5.5' }),
})
