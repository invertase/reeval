import { defineConfig } from 'evalsuite'
import { cursor, opencode } from 'evalsuite/harness'
import { docker } from 'evalsuite/sandbox'

export default defineConfig({
  harness: [cursor({ model: 'composer-2.5' }), opencode({ model: 'gemini-3.8-flash' })],
  sandbox: docker(),
})
