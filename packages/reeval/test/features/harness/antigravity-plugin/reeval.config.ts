import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D). The fake
// agent takes antigravity's layout (and image), so no key is needed. As the agent: read the
// plugin's skill where it was copied, look for it among Antigravity's own skills, and read the
// MCP config the CLI installs the plugin's servers from. In Docker, also install the copy with
// the image's own agy, as the adapter does, and read the MCP config agy installed.
const agy = '~/.ai-sdk-harness/.harness-bootstrap/antigravity/bin/agy'
const docker = process.env.REEVAL_FIXTURE_SANDBOX === 'docker'

export default defineConfig({
  harness: fakeHarness({
    layout: 'antigravity',
    script: [
      [
        { exec: 'cat ~/.reeval/plugins/house/skills/house-style/SKILL.md' },
        {
          exec: 'test -e ~/.gemini/config/skills/house-style && echo placed || echo not placed',
        },
        { exec: 'cat ~/.reeval/plugins/house/.mcp.json' },
        ...(docker
          ? [
              {
                exec: `${agy} plugin install ~/.reeval/plugins/house >/dev/null && cat ~/.gemini/config/plugins/house/mcp_config.json`,
              },
            ]
          : []),
        { reply: 'read' },
      ],
    ],
  }),
})
