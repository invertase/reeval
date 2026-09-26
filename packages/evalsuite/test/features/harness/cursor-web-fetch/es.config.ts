import { defineConfig } from 'evalsuite'
import { cursor } from 'evalsuite/harness'
import { docker } from 'evalsuite/sandbox'

// Real Cursor only (C), with CURSOR_API_KEY: the agent fetches a page with its web tool, and the
// transcript either has the fetch or says it can't (`turn.unreported`), never a silent nothing.
export default defineConfig({
  harness: cursor({
    model: process.env.ES_REAL_MODEL ?? 'composer-2.5',
    params: { fast: 'false' },
  }),
  sandbox: docker(),
})
