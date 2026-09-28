import { defineConfig } from 'reeval'
import { cursor, fakeHarness } from 'reeval/harness'
import { docker, fakeSandbox } from 'reeval/sandbox'

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D).
// REEVAL_FIXTURE_HARNESS=cursor runs it on real Cursor (C), which needs CURSOR_API_KEY.
export default defineConfig({
  harness:
    process.env.REEVAL_FIXTURE_HARNESS === 'cursor'
      ? cursor({ model: process.env.REEVAL_REAL_MODEL ?? 'composer-2.5' })
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
    process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
      ? docker()
      : fakeSandbox({ dir: new URL('./sandboxes', import.meta.url) }),
})
