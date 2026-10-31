import { evaluate, expect } from 'reeval'
import { built } from './env.ts'

// Under OpenCode's layout, a built plugin's subagent is unpacked from the build's output, not from
// the source the plan read, with its frontmatter cut to what OpenCode takes.
evaluate('lands', { environments: built }, async (c) => {
  expect(await c.readFile('.opencode/agents/reviewer.md')).toBe(
    '---\ndescription: Reviews a change.\nmode: subagent\n---\n\nBUILT-58\n',
  )
})
