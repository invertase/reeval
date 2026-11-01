import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { layout, ownSkills } from './layout.ts'

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D). The fake
// agent takes REEVAL_FIXTURE_LAYOUT's layout (and image), so no key is needed. As the agent: read
// the plugin's skill where it was copied, look for it among the harness's own skills, then read
// the MCP config the harness starts the plugin's server from.
export default defineConfig({
  harnesses: fakeHarness({
    layout,
    script: [
      [
        { exec: 'cat ~/.reeval/plugins/house/skills/house-style/SKILL.md' },
        { exec: `test -e ${ownSkills}/house-style && echo placed || echo not placed` },
        { exec: 'cat ~/.reeval/plugins/house/.mcp.json' },
        { reply: 'read' },
      ],
    ],
  }),
})
