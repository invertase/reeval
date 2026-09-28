import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { docker, fakeSandbox } from 'reeval/sandbox'

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D). The fake
// agent takes goose's layout (and image), so no key is needed. As the agent: read the skill
// where the adapter puts it, in Goose's private home, then from the sandbox user's own home.
export default defineConfig({
  harness: fakeHarness({
    layout: 'goose',
    script: [
      [
        {
          exec: 'cat ~/.ai-sdk-harness/.harness-bootstrap/goose/implementation/home/.config/goose/skills/house-greeting/SKILL.md',
        },
        { exec: 'cat ~/.config/goose/skills/house-greeting/SKILL.md' },
        { reply: 'read' },
      ],
    ],
  }),
  sandbox:
    process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
      ? docker()
      : fakeSandbox({ dir: new URL('./sandboxes', import.meta.url) }),
})
