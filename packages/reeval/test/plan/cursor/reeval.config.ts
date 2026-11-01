import { defineConfig } from 'reeval'
import { cursor } from 'reeval/harness'

export default defineConfig({
  harnesses: [
    cursor({ model: 'composer-2.5', params: { fast: 'false' } }),
    cursor({ model: 'composer-2.5', params: { fast: 'true' }, id: 'composer-fast' }),
  ],
})
