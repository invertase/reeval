import { defineConfig } from 'reeval'
import { direct, vercel } from 'reeval/gateway'
import { cursor, fx } from 'reeval/harness'

export default defineConfig({
  harness: [cursor({ model: 'composer-2.5' }), fx({ model: 'anthropic/claude-sonnet-5' })],
  // fx's own OpenAI id on its key; a gateway id only through Vercel.
  gateway: [direct(), vercel()],
})
