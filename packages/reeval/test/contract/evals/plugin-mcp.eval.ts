import { evaluate, expect } from 'reeval'
import { MCP_LOG, plugged, prompts, toolNames, withFakePlugin } from './probes.ts'

// The probe plugin's stdio MCP server starts in the sandbox and the agent calls its tool: the
// server logged the call, and a transcript tool names it (each harness namespaces it its own way).
const options = { environment: plugged, harness: withFakePlugin, tags: ['plugin'] }

evaluate('plugin mcp', options, async (c) => {
  const turn = await c.send(prompts.pluginMcp)
  expect((await c.readFile(MCP_LOG)) ?? '').toContain('tools/call')
  expect(toolNames(turn).filter((t) => /^mcp__.*stamp__house_stamp$/.test(t))).not.toEqual([])
})

// Must fail: with no turn, nothing has called the tool.
evaluate('plugin mcp canary', options, async (c) => {
  expect((await c.readFile(MCP_LOG)) ?? '').toContain('tools/call')
})
