import { defineConfig } from 'evalsuite'
import { cursor, fakeHarness } from 'evalsuite/harness'
import { docker, fakeSandbox } from 'evalsuite/sandbox'

// ES_FIXTURE_SANDBOX=docker is the Docker tier (D); ES_FIXTURE_HARNESS=cursor adds real Cursor (C),
// which needs CURSOR_API_KEY. The fake sandbox can't model the server's absolute path.
export default defineConfig({
  harness:
    process.env.ES_FIXTURE_HARNESS === 'cursor'
      ? cursor({ model: process.env.ES_REAL_MODEL ?? 'composer-2.5' })
      : // As the agent: start the environment's stdio server and call its tool.
        fakeHarness({ script: [[{ mcp: 'stamp/house_stamp' }, { reply: 'stamped' }]] }),
  sandbox:
    process.env.ES_FIXTURE_SANDBOX === 'docker'
      ? docker()
      : fakeSandbox({ dir: new URL('./sandboxes', import.meta.url) }),
})
