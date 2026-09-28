import { evaluate, expect } from 'reeval'
import { LOG, prompt, stamp } from './env.ts'

// The agent reached the environment's stdio MCP server: the server logged the tool call.
evaluate('lands', { environment: stamp }, async (t) => {
  await t.send(prompt)
  expect((await t.readFile(LOG)) ?? '').toContain('tools/call')
})
