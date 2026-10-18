import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D). The fake
// agent takes fx's layout (and image), so no key is needed. As the agent: read the skill
// where the adapter puts it, in fx's private home, then from the sandbox user's own home.
export default defineConfig({
  harness: fakeHarness({
    layout: 'fx',
    script: [
      [
        {
          exec: 'cat ~/.ai-sdk-harness/.harness-bootstrap/fx/implementation/home/.fx/skills/house-greeting/SKILL.md',
        },
        { exec: 'cat ~/.fx/skills/house-greeting/SKILL.md' },
        { reply: 'read' },
      ],
    ],
  }),
})
