import { evaluate, expect } from 'reeval'
import { house, loaded, shellOutput } from './env.ts'

// Under Claude Code's layout, the plugin is enabled from a directory marketplace in
// ~/.claude/settings.json, beside the settings the environment wrote there, and its MCP server is
// left to Claude Code, not the agent's MCP config.
evaluate('lands', { environments: house }, async (c) => {
  const turn = await c.send('read the plugin settings')
  const settings = JSON.parse(shellOutput(turn, 0) ?? '{}')
  expect(settings.enabledPlugins).toEqual({ 'other@elsewhere': false, 'house@reeval': true })
  expect(settings.env).toEqual({ HOUSE: '1' })
  expect(settings.extraKnownMarketplaces.reeval.source.source).toBe('directory')
  expect(shellOutput(turn, 1)).toContain('"source": "./house"')
  expect(shellOutput(turn, 2)).toContain('Write every name in kebab-case.')
  expect(loaded(turn)).not.toContain('house:docs')
  // The placed plugin's server goes through reeval's MCP timer, at its placed stamp.mjs.
  const { mcpServers } = JSON.parse(shellOutput(turn, 3) ?? '{}')
  expect(mcpServers.docs.args.slice(1, 4)).toEqual(['--name', 'house:docs', '--'])
  expect(mcpServers.docs.args.at(-1)).toMatch(/\/\.reeval\/plugins\/house\/stamp\.mjs$/)
})
