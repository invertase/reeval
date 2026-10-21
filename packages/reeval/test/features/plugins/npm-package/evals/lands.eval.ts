import { evaluate, expect } from 'reeval'
import { pinned, stamped } from './env.ts'

// plugin.npm places the pinned version, and its MCP server joins the environment as review:docs.
evaluate('lands', { environment: pinned }, async (c) => {
  expect(stamped(await c.send('Stamp it.'))).toBe('STAMP-7Q')
})
