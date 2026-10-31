import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D). The fake
// agent takes fx's layout (and image), so no key is needed. As the agent: follow the plugin's skill
// among fx's own skills, in its private home, where the session placed it.
export default defineConfig({
  harnesses: fakeHarness({
    layout: 'fx',
    script: [
      [
        {
          exec: `grep -o 'PLOVER-[0-9]*' ~/.ai-sdk-harness/.harness-bootstrap/fx/home/.fx/skills/house-style/SKILL.md > style.txt`,
        },
        { reply: 'done' },
      ],
    ],
  }),
})
