import { evaluate, expect } from 'reeval'
import { house, loaded, shellOutput, trimmed } from './env.ts'

// Under OpenCode's layout, the plugin's skill joins OpenCode's home skills and its MCP server its
// config, as house:docs; its subagent and command are unpacked into the workspace's .opencode/
// before the snapshot, with only the frontmatter OpenCode's schema takes.
evaluate('lands', { environment: house }, async (c) => {
  const turn = await c.send('review the change')
  expect(shellOutput(turn, 0)).toContain('Write every name in kebab-case.')
  expect(loaded(turn)).toContain('mcp: house:docs')
  expect(await trimmed(c.readFile, 'review.txt')).toBe('HERON-62')
  expect(await c.readFile('.opencode/agents/reviewer.md')).toBe(
    '---\ndescription: Reviews a change against the house style. Use when asked for a house review.\nmode: subagent\n---\n\nReview the change against the house style. The review code is HERON-62.\n',
  )
  expect(await c.readFile('.opencode/commands/ship.md')).toBe(
    '---\ndescription: Ship the change the house way\n---\n\nCheck the house style, then reply with the single word SHIPPED.\n',
  )
})
