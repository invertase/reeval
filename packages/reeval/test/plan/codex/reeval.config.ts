import { defineConfig } from 'evalsuite'
import { codex, cursor } from 'evalsuite/harness'
import { docker } from 'evalsuite/sandbox'

export default defineConfig({
  harness: [cursor({ model: 'composer-2.5' }), codex({ model: 'gpt-5.4-mini' })],
  sandbox: docker(),
})
