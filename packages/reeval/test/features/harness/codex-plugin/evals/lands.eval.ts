import { evaluate, expect } from 'reeval'
import { house, loaded, shellOutput } from './env.ts'

// Under Codex's layout, the plugin stays whole where the session copied it (Codex installs it from
// its home marketplace): its skill isn't placed with Codex's own, and its MCP server is left to
// Codex.
evaluate('lands', { environment: house }, async (c) => {
  const turn = await c.send('read the plugin')
  expect(shellOutput(turn, 0)).toContain('Write every name in kebab-case.')
  expect(shellOutput(turn, 1)).toBe('not placed\n')
  expect(loaded(turn)).toContain('plugins: house (skills, mcp)')
  expect(loaded(turn)).not.toContain('house:docs')
  // The placed plugin's server goes through reeval's MCP timer, at its placed stamp.mjs.
  const { mcpServers } = JSON.parse(shellOutput(turn, 2) ?? '{}')
  expect(mcpServers.docs.args.slice(1, 4)).toEqual(['--name', 'house:docs', '--'])
  expect(mcpServers.docs.args.at(-1)).toMatch(/\/\.reeval\/plugins\/house\/stamp\.mjs$/)
})
