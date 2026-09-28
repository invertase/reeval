import { defineConfig } from 'evalsuite'
import { cursor } from 'evalsuite/harness'
import { docker } from 'evalsuite/sandbox'

// Real Cursor only (C), with CURSOR_API_KEY: the tokens come from Cursor's own exchange. The
// gateway side is covered without a key in sandbox-docker's proxy and Docker tests.
export default defineConfig({
  harness: cursor({ model: process.env.ES_REAL_MODEL ?? 'composer-2.5' }),
  sandbox: docker(),
})
