import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D). The fake
// agent takes grok-build's layout (and image), so no key is needed. As the agent: read the skill
// where the adapter puts it, in Grok Build's private home, then from the sandbox user's own home.
export default defineConfig({
  harness: fakeHarness({
    layout: 'grok-build',
    script: [
      [
        {
          exec: 'cat ~/.ai-sdk-harness/.harness-bootstrap/grok-build/implementation/home/.grok/skills/house-greeting/SKILL.md',
        },
        { exec: 'cat ~/.grok/skills/house-greeting/SKILL.md' },
        { reply: 'read' },
      ],
    ],
  }),
})
