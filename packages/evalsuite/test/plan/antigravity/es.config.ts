import { defineConfig } from 'evalsuite'
import { antigravity, cursor } from 'evalsuite/harness'
import { docker } from 'evalsuite/sandbox'

export default defineConfig({
  harness: [cursor({ model: 'composer-2.5' }), antigravity({ model: 'gemini-3.8-flash-medium' })],
  sandbox: docker(),
})
