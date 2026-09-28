import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { docker, fakeSandbox } from 'reeval/sandbox'

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D). The fake
// agent takes Codex's layout (and image), so no key is needed. As the agent: read the skill
// where the adapter puts it, then from ~/.codex/skills.
export default defineConfig({
  harness: fakeHarness({
    layout: 'codex',
    script: [
      [
        { exec: 'cat ~/.agents/skills/house-greeting/SKILL.md' },
        { exec: 'cat ~/.codex/skills/house-greeting/SKILL.md' },
        { reply: 'read' },
      ],
    ],
  }),
  sandbox:
    process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
      ? docker()
      : fakeSandbox({ dir: new URL('./sandboxes', import.meta.url) }),
})
