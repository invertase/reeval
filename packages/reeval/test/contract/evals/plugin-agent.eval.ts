import { evaluate, expect, type Turn } from 'reeval'
import {
  closed,
  delegatedTo,
  PLUGIN_AGENT,
  plugged,
  prompts,
  toolsMentioning,
  withFakePlugin,
} from './probes.ts'

// The probe plugin's subagent is available: the agent delegates to it by name, and the call
// succeeds. Without the plugin, an agent asked the same either calls a subagent it doesn't have
// (refused) or searches for it, and neither counts. The scripted fake agent has no subagent tool,
// so on the key-free row it reads the placed subagent instead. Tagged plugin-agents too, so a
// harness that loads plugins but not their subagents leaves these out.
const tags = ['plugin', 'plugin-agents']

const delegated = (turn: Turn) =>
  process.env.REEVAL_CONTRACT_HARNESS
    ? delegatedTo(turn, PLUGIN_AGENT)
    : toolsMentioning(turn, PLUGIN_AGENT)

evaluate('plugin subagent', { environment: plugged, harness: withFakePlugin, tags }, async (c) => {
  expect(delegated(await c.send(prompts.pluginAgent))).not.toEqual([])
})

// Must fail: the same turn without the plugin delegates to no such subagent.
evaluate('plugin subagent canary', { environment: closed, tags }, async (c) => {
  expect(delegated(await c.send(prompts.pluginAgent))).not.toEqual([])
})
