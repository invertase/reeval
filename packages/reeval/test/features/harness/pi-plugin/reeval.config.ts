import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D). The fake
// agent takes pi's layout (and image), so no key is needed. As the agent: read the plugin's skill
// among pi's own, and expand the command reeval unpacked as a prompt template in .pi/prompts.
export default defineConfig({
  harnesses: fakeHarness({
    layout: 'pi',
    script: [
      [
        { exec: 'cat ~/.pi/agent/skills/house-style/SKILL.md' },
        { exec: `grep -o 'KESTREL-[0-9]*' .pi/prompts/ship.md > release.txt` },
        { reply: 'done' },
      ],
    ],
  }),
})
