import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// Docker only: the environments set docker() themselves. The fake agent takes OpenCode's layout
// (and image), so reeval unpacks the plugin's subagent into the workspace's .opencode/agents.
export default defineConfig({
  harness: fakeHarness({ layout: 'opencode' }),
})
