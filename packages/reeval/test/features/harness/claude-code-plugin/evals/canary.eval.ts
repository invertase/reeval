import { evaluate, expect } from 'reeval'
import { house, loaded } from './env.ts'

// Must fail: the plugin's MCP server isn't also in the agent's MCP config.
evaluate('canary', { environment: house }, async (c) => {
  const turn = await c.send('read the plugin settings')
  expect(loaded(turn)).toContain('mcp: house:docs')
})
