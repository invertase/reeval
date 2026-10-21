import { evaluate, expect } from 'reeval'
import { house, loaded, shellOutput } from './env.ts'

// Under Claude Code's layout, the plugin is enabled from a directory marketplace in
// ~/.claude/settings.json, and its MCP server is left to Claude Code, not the agent's MCP config.
evaluate('lands', { environment: house }, async (c) => {
  const turn = await c.send('read the plugin settings')
  const settings = JSON.parse(shellOutput(turn, 0) ?? '{}')
  expect(settings.enabledPlugins).toEqual({ 'house@reeval': true })
  expect(settings.extraKnownMarketplaces.reeval.source.source).toBe('directory')
  expect(shellOutput(turn, 1)).toContain('"source": "./house"')
  expect(shellOutput(turn, 2)).toContain('Write every name in kebab-case.')
  expect(loaded(turn)).not.toContain('house:docs')
})
