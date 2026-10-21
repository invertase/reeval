import { evaluate, expect } from 'reeval'
import { house, loaded, trimmed } from './env.ts'

// Under fx's layout, which has no plugins of its own, the plugin's skill joins fx's home skills
// and its MCP server goes over ACP with the environment's, as house:docs.
evaluate('lands', { environment: house }, async (c) => {
  const turn = await c.send('follow the house style')
  expect(loaded(turn)).toContain('mcp: house:docs')
  expect(await trimmed(c.readFile, 'style.txt')).toBe('PLOVER-27')
})
