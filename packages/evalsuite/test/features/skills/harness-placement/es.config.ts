import { defineConfig } from 'evalsuite'
import { fakeHarness } from 'evalsuite/harness'
import { docker, fakeSandbox } from 'evalsuite/sandbox'

// ES_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D).
export default defineConfig({
  // As the agent: read the skill where the Cursor adapter puts it, then where workspace skills go.
  harness: fakeHarness({
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
