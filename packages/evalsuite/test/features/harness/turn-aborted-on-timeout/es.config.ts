import { defineConfig } from 'evalsuite'
import { cursor, fakeHarness } from 'evalsuite/harness'
import { docker, fakeSandbox } from 'evalsuite/sandbox'

// ES_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D).
// ES_FIXTURE_HARNESS=cursor runs it on real Cursor (C), which needs CURSOR_API_KEY.
export default defineConfig({
  harness:
    process.env.ES_FIXTURE_HARNESS === 'cursor'
      ? cursor({ model: process.env.ES_REAL_MODEL ?? 'composer-2.5' })
      : fakeHarness({ delayMs: 10_000 }),
  sandbox:
    process.env.ES_FIXTURE_SANDBOX === 'docker'
      ? docker()
      : fakeSandbox({ dir: new URL('./sandboxes', import.meta.url).pathname }),
})
