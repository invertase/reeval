import { defineConfig } from 'evalsuite'
import { cursor } from 'evalsuite/harness'
import { docker } from 'evalsuite/sandbox'

// Real Cursor only (C), with CURSOR_API_KEY: the SDK reports each turn's tokens and the model it
// resolved, and ES records both.
export default defineConfig({
  harness: cursor({
    model: process.env.ES_REAL_MODEL ?? 'composer-2.5',
    params: { fast: 'false' },
  }),
  sandbox: docker(),
})
