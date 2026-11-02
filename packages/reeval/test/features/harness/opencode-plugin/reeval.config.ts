import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D). The fake
// agent takes OpenCode's layout (and image), so no key is needed. As the agent: read the plugin's
// skill among OpenCode's own, and follow the subagent reeval unpacked into .opencode/agents.
export default defineConfig({
  harnesses: fakeHarness({
    layout: 'opencode',
    script: [
      [
        { exec: 'cat ~/.config/opencode/skills/house-style/SKILL.md' },
        { exec: `grep -o 'HERON-[0-9]*' .opencode/agents/reviewer.md > review.txt` },
        { reply: 'done' },
      ],
    ],
  }),
})
