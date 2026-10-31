import { defineConfig } from 'reeval'
import { cursor, fakeHarness } from 'reeval/harness'

// REEVAL_FIXTURE_SANDBOX=docker is the Docker tier (D); REEVAL_FIXTURE_HARNESS=cursor adds real Cursor (C),
// which needs CURSOR_API_KEY. The fake sandbox can't model the server's absolute path.
export default defineConfig({
  harnesses:
    process.env.REEVAL_FIXTURE_HARNESS === 'cursor'
      ? cursor({ model: process.env.REEVAL_REAL_MODEL ?? 'composer-2.5' })
      : // As the agent: start the environment's stdio server and call its tool.
        fakeHarness({ script: [[{ mcp: 'stamp/house_stamp' }, { reply: 'stamped' }]] }),
})
