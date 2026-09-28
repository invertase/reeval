import { defineConfig } from 'evalsuite'
import { cursor, goose } from 'evalsuite/harness'
import { docker } from 'evalsuite/sandbox'

export default defineConfig({
  harness: [cursor({ model: 'composer-2.5' }), goose({ model: 'gemini-3.8-flash' })],
  sandbox: docker(),
})
