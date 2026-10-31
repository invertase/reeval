import { evaluate, expect } from 'reeval'
import { unbuilt } from './env.ts'

// Must fail: this build writes nothing, so the unpacked subagent is the source's placeholder.
evaluate('canary', { environments: unbuilt }, async (c) => {
  expect(await c.readFile('.opencode/agents/reviewer.md')).toContain('BUILT-58')
})
