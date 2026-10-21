import { evaluate, expect } from 'reeval'
import { PLUGIN_PROOF, plugged, prompts, trimmed, withFakePlugin } from './probes.ts'

// The probe plugin's skill reaches the agent and it uses it: the proof it writes is only in that
// skill. The record (host side) shows where the skill was placed, and nothing undeclared.
// Tagged so a harness that can't load plugins runs the rest with --tag '!plugin'.
const options = { environment: plugged, harness: withFakePlugin, tags: ['plugin'] }

evaluate('plugin skill', options, async (c) => {
  await c.send(prompts.pluginSkill)
  expect(await trimmed(c.readFile, 'plugin-proof.txt')).toBe(PLUGIN_PROOF)
})

// Must fail: with no turn, nothing has written the proof.
evaluate('plugin skill canary', options, async (c) => {
  expect(await trimmed(c.readFile, 'plugin-proof.txt')).toBe(PLUGIN_PROOF)
})
