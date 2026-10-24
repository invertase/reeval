import { defineEnvironment, evaluate, expect } from 'reeval'

// The package in ./project, and the release plugin's skill and MCP server. Its command stays
// out: `only` places just the parts listed.
const app = defineEnvironment('acme-math', ({ directory, plugin }) => ({
  files: directory('./project'),
  plugins: [plugin.local('./plugins/release', { only: ['skills', 'mcp'] })],
}))

evaluate('prepares the next release', { environment: app }, async (c) => {
  const turn = await c.send('Prepare the next release.')

  // A plugin's MCP servers are named <plugin>:<server>.
  expect(turn).toHaveCalledMcp('release:releases', 'next_version')
  await expect(turn).toHaveFile('package.json', /"version": "1\.3\.0"/)
  await expect(turn).toHaveFile('CHANGELOG.md', /^## 1\.3\.0\s+- feat: add multiply/)
})
