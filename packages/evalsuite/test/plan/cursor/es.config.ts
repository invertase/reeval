import { defineConfig } from 'evalsuite'
import { cursor } from 'evalsuite/harness'
import { docker } from 'evalsuite/sandbox'

export default defineConfig({
  harness: [
    cursor({ model: 'composer-2.5', params: { fast: 'false' } }),
    cursor({ model: 'composer-2.5', params: { fast: 'true' }, id: 'composer-fast' }),
  ],
  sandbox: docker(),
})
