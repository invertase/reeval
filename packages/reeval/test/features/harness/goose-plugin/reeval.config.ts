import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D). The fake
// agent takes goose's layout (and image), so no key is needed. As the agent: read the plugin's
// skill among Goose's own skills, in its private home, where the session placed it.
export default defineConfig({
  harness: fakeHarness({
    layout: 'goose',
    script: [
      [
        {
          exec: 'cat ~/.ai-sdk-harness/.harness-bootstrap/goose/home/.config/goose/skills/house-style/SKILL.md',
        },
        { reply: 'read' },
      ],
    ],
  }),
})
