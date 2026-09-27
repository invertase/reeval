import { defineConfig } from 'evalsuite'
import { fakeHarness } from 'evalsuite/harness'
import { docker, fakeSandbox } from 'evalsuite/sandbox'

// ES_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D). The fake
// agent takes claude-code's layout (and image), so no key is needed. As the agent: read the skill
// where Claude Code's adapter puts harness skills, then where its workspace skills go.
export default defineConfig({
  harness: fakeHarness({
    layout: 'claude-code',
    script: [
      [
        { exec: 'cat ~/.claude/skills/house-greeting/SKILL.md' },
        { exec: 'cat .claude/skills/house-greeting/SKILL.md' },
        { reply: 'read' },
      ],
    ],
  }),
  sandbox:
    process.env.ES_FIXTURE_SANDBOX === 'docker'
      ? docker()
      : fakeSandbox({ dir: new URL('./sandboxes', import.meta.url) }),
})
