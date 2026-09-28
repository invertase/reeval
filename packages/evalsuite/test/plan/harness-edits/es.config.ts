import { defineConfig } from 'evalsuite'
import { claudeCode, cursor } from 'evalsuite/harness'
import { docker } from 'evalsuite/sandbox'

export default defineConfig({
  harness: [cursor({ model: 'composer-2.5' }), claudeCode({ model: 'claude-sonnet-5' })],
  sandbox: docker(),
})
