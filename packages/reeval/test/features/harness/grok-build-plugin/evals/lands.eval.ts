import { evaluate, expect } from 'reeval'
import { house, loaded, shellOutput } from './env.ts'

// Under Grok Build's layout, the plugin stays whole where the session copied it (Grok loads it
// with --plugin-dir): its skill isn't placed with Grok's own, and its MCP server is left to Grok.
evaluate('lands', { environment: house }, async (c) => {
  const turn = await c.send('read the plugin')
  expect(shellOutput(turn, 0)).toContain('Write every name in kebab-case.')
  expect(shellOutput(turn, 1)).toBe('not placed\n')
  expect(loaded(turn)).toContain('plugins: house (skills, mcp)')
  expect(loaded(turn)).not.toContain('house:docs')
})
