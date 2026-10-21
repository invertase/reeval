import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D). The fake
// agent takes codex's layout (and image), so no key is needed. As the agent: read the plugin's
// skill where it was copied, look for it among Codex's own skills, then read the MCP config that
// `codex plugin add` copies into Codex's cache with the plugin.
export default defineConfig({
  harness: fakeHarness({
    layout: 'codex',
    script: [
      [
        { exec: 'cat ~/.reeval/plugins/house/skills/house-style/SKILL.md' },
        { exec: 'test -e ~/.agents/skills/house-style && echo placed || echo not placed' },
        { exec: 'cat ~/.reeval/plugins/house/.mcp.json' },
        { reply: 'read' },
      ],
    ],
  }),
})
