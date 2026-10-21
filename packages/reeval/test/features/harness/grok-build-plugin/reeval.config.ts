import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D). The fake
// agent takes grok-build's layout (and image), so no key is needed. As the agent: read the
// plugin's skill where it was copied, look for it among Grok's own skills, then read the MCP
// config it starts the plugin's server from.
export default defineConfig({
  harness: fakeHarness({
    layout: 'grok-build',
    script: [
      [
        { exec: 'cat ~/.reeval/plugins/house/skills/house-style/SKILL.md' },
        {
          exec: 'test -e ~/.ai-sdk-harness/.harness-bootstrap/grok-build/implementation/home/.grok/skills/house-style && echo placed || echo not placed',
        },
        { exec: 'cat ~/.reeval/plugins/house/.mcp.json' },
        { reply: 'read' },
      ],
    ],
  }),
})
