import { defineConfig } from 'evalsuite'
import { fakeHarness } from 'evalsuite/harness'
import { docker, fakeSandbox } from 'evalsuite/sandbox'

// ES_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D). The fake
// agent takes antigravity's layout (and image), so no key is needed. As the agent: read the skill
// where the adapter puts it (and CLI 1.2.11 reads it), then where the CLI's docs say it goes.
export default defineConfig({
  harness: fakeHarness({
    layout: 'antigravity',
    script: [
      [
        { exec: 'cat ~/.gemini/config/skills/house-greeting/SKILL.md' },
        { exec: 'cat ~/.gemini/antigravity-cli/skills/house-greeting/SKILL.md' },
        { reply: 'read' },
      ],
    ],
  }),
  sandbox:
    process.env.ES_FIXTURE_SANDBOX === 'docker'
      ? docker()
      : fakeSandbox({ dir: new URL('./sandboxes', import.meta.url) }),
})
