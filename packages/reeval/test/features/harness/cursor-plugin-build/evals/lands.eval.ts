import { evaluate, expect } from 'reeval'
import { built } from './env.ts'

// Under Cursor's layout, a built plugin's subagent is unpacked from the build's output, not from
// the source the plan read.
evaluate('lands', { environment: built }, async (c) => {
  expect(await c.readFile('.cursor/agents/reviewer.md')).toContain('BUILT-41')
})
