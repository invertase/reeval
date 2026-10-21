import { evaluate, expect } from 'reeval'
import {
  closed,
  PLUGIN_AGENT,
  plugged,
  prompts,
  toolsMentioning,
  withFakePlugin,
} from './probes.ts'

// The probe plugin's subagent is available: the agent delegates to it, and a transcript tool
// names it. Tagged plugin-agents too, so a harness that loads plugins but not their subagents
// leaves these out.
const tags = ['plugin', 'plugin-agents']

evaluate('plugin subagent', { environment: plugged, harness: withFakePlugin, tags }, async (c) => {
  const turn = await c.send(prompts.pluginAgent)
  expect(toolsMentioning(turn, PLUGIN_AGENT)).not.toEqual([])
})

// Must fail: without the plugin and with no turn, nothing delegates to the subagent.
evaluate('plugin subagent canary', { environment: closed, tags }, async () => {
  expect(toolsMentioning(undefined, PLUGIN_AGENT)).not.toEqual([])
})
