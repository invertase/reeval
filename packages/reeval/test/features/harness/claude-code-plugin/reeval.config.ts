import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D). The fake
// agent takes claude-code's layout (and image), so no key is needed. As the agent: read the
// settings and marketplace that enable the plugin, and the plugin's skill where it was copied.
export default defineConfig({
  harness: fakeHarness({
    layout: 'claude-code',
    script: [
      [
        { exec: 'cat ~/.claude/settings.json' },
        { exec: 'cat ~/.reeval/plugins/.claude-plugin/marketplace.json' },
        { exec: 'cat ~/.reeval/plugins/house/skills/house-style/SKILL.md' },
        { reply: 'read' },
      ],
    ],
  }),
})
