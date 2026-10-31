import { evaluate, expect } from 'reeval'
import { house, loaded, shellOutput } from './env.ts'

// Under Goose's layout, the plugin's items join Goose's own: its skill is placed with Goose's home
// skills, and its MCP server is an extension in Goose's config, as house:docs.
evaluate('lands', { environments: house }, async (c) => {
  const turn = await c.send('read the plugin')
  expect(shellOutput(turn, 0)).toContain('Write every name in kebab-case.')
  expect(loaded(turn)).toContain('plugins: house (skills, mcp)')
  expect(loaded(turn)).toContain('mcp: house:docs')
})
