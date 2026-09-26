import { evaluate, expect } from 'evalsuite'
import { MCP_LOG, prompts, stamped, toolNames, withFakeMcp } from './probes.ts'

// The environment's stdio MCP server is started in the sandbox and the agent calls its tool: the
// server logged the call, and the transcript names it mcp__<server>__<tool>.
evaluate('mcp', { environment: stamped, harness: withFakeMcp }, async (t) => {
  const turn = await t.send(prompts.mcp)
  expect((await t.readFile(MCP_LOG)) ?? '').toContain('tools/call')
  expect(toolNames(turn)).toContain('mcp__stamp__house_stamp')
})

// Must fail: with no turn, nothing has called the tool.
evaluate('mcp canary', { environment: stamped, harness: withFakeMcp }, async (t) => {
  await t.sandbox()
  expect((await t.readFile(MCP_LOG)) ?? '').toContain('tools/call')
})
