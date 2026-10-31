import { evaluate, expect } from 'reeval'
import { house, loaded, shellOutput } from './env.ts'

// Under Antigravity's layout, the plugin stays whole where the session copied it (the adapter
// installs it with agy plugin install): its skill isn't placed with Antigravity's own, its rule
// isn't refused, and its MCP server is left to the CLI, from the plugin's rewritten .mcp.json.
evaluate('lands', { environments: house }, async (c) => {
  const turn = await c.send('read the plugin')
  expect(shellOutput(turn, 0)).toContain('Write every name in kebab-case.')
  expect(shellOutput(turn, 1)).toBe('not placed\n')
  expect(loaded(turn)).toContain('plugins: house (skills, mcp, rules)')
  expect(loaded(turn)).not.toContain('house:docs')
  // The placed plugin's server goes through reeval's MCP timer, at its placed stamp.mjs.
  const { mcpServers } = JSON.parse(shellOutput(turn, 2) ?? '{}')
  expect(mcpServers.docs.args.slice(1, 4)).toEqual(['--name', 'house:docs', '--'])
  expect(mcpServers.docs.args.at(-1)).toMatch(/\/\.reeval\/plugins\/house\/stamp\.mjs$/)
  if (process.env.REEVAL_FIXTURE_SANDBOX !== 'docker') return
  // What agy installed is the timed server, not the plugin's own.
  const installed = JSON.parse(shellOutput(turn, 3) ?? '{}')
  expect(installed.mcpServers.docs.args.slice(1, 4)).toEqual(['--name', 'house:docs', '--'])
})
