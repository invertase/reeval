import { evaluate, expect } from 'reeval'
import { house, loaded, shellOutput, trimmed } from './env.ts'

// Under pi's layout, the plugin's skill joins pi's home skills and its MCP server its mcp.json, as
// house:docs; its command is unpacked as one of the workspace's prompt templates before the
// snapshot, as it is (pi reads Claude Code's description and argument-hint).
evaluate('lands', { environment: house }, async (c) => {
  const turn = await c.send('/ship main')
  expect(shellOutput(turn, 0)).toContain('Write every name in kebab-case.')
  expect(loaded(turn)).toContain('mcp: house:docs')
  expect(await trimmed(c.readFile, 'release.txt')).toBe('KESTREL-19')
  expect(await c.readFile('.pi/prompts/ship.md')).toContain("argument-hint: '[branch]'")
})
