import { evaluate, expect } from 'reeval'
import { house, prompt, trimmed } from './env.ts'

// Under Cursor's layout, reeval unpacks the plugin's rule, subagent, command and hooks into the
// workspace's .cursor/ before the snapshot: the agent follows the rule, and its session ran the
// hook, with ${CLAUDE_PLUGIN_ROOT} filled in with where the plugin was copied.
evaluate('lands', { environment: house }, async (c) => {
  await c.send(prompt)
  expect(await trimmed(c.readFile, 'codeword.txt')).toBe('SAFFRON-73')
  expect(await trimmed(c.readFile, '~/.reeval/plugins/house/hook-ran.txt')).toBe('house-hook-ran')
  const hooks = JSON.parse((await c.readFile('.cursor/hooks.json')) ?? '{}')
  expect(hooks.version).toBe(1)
  expect(Object.keys(hooks.hooks)).toEqual(['sessionStart'])
  expect(hooks.hooks.sessionStart).toHaveLength(1)
  expect(hooks.hooks.sessionStart[0].type).toBe('command')
  expect(hooks.hooks.sessionStart[0].command).toMatch(
    /^cp (\/\S+\/\.reeval\/plugins\/house)\/marker\.txt \1\/hook-ran\.txt$/,
  )
  expect(await c.readFile('.cursor/rules/house-codeword.mdc')).toMatch(
    /^---\nalwaysApply: true\n---\n\n# House codeword\n/,
  )
  expect(await c.readFile('.cursor/agents/reviewer.md')).toContain('name: reviewer')
  expect(await c.readFile('.cursor/commands/ship.md')).toContain('SHIPPED')
})
