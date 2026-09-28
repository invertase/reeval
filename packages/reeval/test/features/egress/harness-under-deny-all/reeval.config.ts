import { defineConfig } from 'reeval'
import { cursor, fakeHarness } from 'reeval/harness'
import { docker, fakeSandbox } from 'reeval/sandbox'
import { reach } from './evals/env.ts'

// REEVAL_FIXTURE_SANDBOX=docker is the Docker tier (D); REEVAL_FIXTURE_HARNESS=cursor is real Cursor (C).
// The fake agent with Cursor's layout gets Cursor's hosts, as real Cursor does.
export default defineConfig({
  harness:
    process.env.REEVAL_FIXTURE_HARNESS === 'cursor'
      ? cursor({ model: process.env.REEVAL_REAL_MODEL ?? 'composer-2.5' })
      : fakeHarness({ layout: 'cursor', script: [[{ exec: reach('api2.cursor.sh') }]] }),
  sandbox:
    process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
      ? docker()
      : fakeSandbox({ dir: new URL('./sandboxes', import.meta.url) }),
})
