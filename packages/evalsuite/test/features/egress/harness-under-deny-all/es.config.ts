import { defineConfig } from 'evalsuite'
import { cursor, fakeHarness } from 'evalsuite/harness'
import { docker, fakeSandbox } from 'evalsuite/sandbox'
import { reach } from './evals/env.ts'

// ES_FIXTURE_SANDBOX=docker is the Docker tier (D); ES_FIXTURE_HARNESS=cursor is real Cursor (C).
// The fake agent with Cursor's layout gets Cursor's hosts, as real Cursor does.
export default defineConfig({
  harness:
    process.env.ES_FIXTURE_HARNESS === 'cursor'
      ? cursor({ model: process.env.ES_REAL_MODEL ?? 'composer-2.5' })
      : fakeHarness({ layout: 'cursor', script: [[{ exec: reach('api2.cursor.sh') }]] }),
  sandbox:
    process.env.ES_FIXTURE_SANDBOX === 'docker'
      ? docker()
      : fakeSandbox({ dir: new URL('./sandboxes', import.meta.url).pathname }),
})
