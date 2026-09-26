import { defineConfig } from 'evalsuite'
import { cursor, fakeHarness } from 'evalsuite/harness'
import { docker, fakeSandbox } from 'evalsuite/sandbox'

// ES_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D).
// ES_FIXTURE_HARNESS=cursor runs it on real Cursor (C), which needs CURSOR_API_KEY.
export default defineConfig({
  harness:
    process.env.ES_FIXTURE_HARNESS === 'cursor'
      ? cursor({ model: process.env.ES_REAL_MODEL ?? 'composer-2.5' })
      : // As the agent: read the skill where the Cursor adapter puts it, then where workspace skills go.
        fakeHarness({
          script: [
            [
              { exec: 'cat ~/.agents/skills/house-greeting/SKILL.md' },
              { exec: 'cat .agents/skills/house-greeting/SKILL.md' },
              { reply: 'read' },
            ],
          ],
        }),
  sandbox:
    process.env.ES_FIXTURE_SANDBOX === 'docker'
      ? docker()
      : fakeSandbox({ dir: new URL('./sandboxes', import.meta.url).pathname }),
})
