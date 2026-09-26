import { defineConfig } from 'evalsuite'
import { fakeHarness } from 'evalsuite/harness'
import { docker, fakeSandbox } from 'evalsuite/sandbox'

// ES_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D). The fake
// agent takes opencode's layout (and image), so no key is needed. As the agent: read the skill
// where the adapter puts it, then from ~/.agents/skills.
export default defineConfig({
  harness: fakeHarness({
    layout: 'opencode',
    script: [
      [
        { exec: 'cat ~/.config/opencode/skills/house-greeting/SKILL.md' },
        { exec: 'cat ~/.agents/skills/house-greeting/SKILL.md' },
        { reply: 'read' },
      ],
    ],
  }),
  sandbox:
    process.env.ES_FIXTURE_SANDBOX === 'docker'
      ? docker()
      : fakeSandbox({ dir: new URL('./sandboxes', import.meta.url).pathname }),
})
