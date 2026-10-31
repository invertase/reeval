import { evaluate, expect } from 'reeval'
import { closed, PLUGIN_RULES_WORD, plugged, prompts, trimmed, withFakePlugin } from './probes.ts'

// The probe plugin's rule is read: the codeword it writes is only in the rule. Tagged plugin-rules
// too, so a harness that loads plugins but not their rules leaves these out.
const tags = ['plugin', 'plugin-rules']

evaluate('plugin rules', { environments: plugged, harnesses: withFakePlugin, tags }, async (c) => {
  await c.send(prompts.pluginRules)
  expect(await trimmed(c.readFile, 'plugin-codeword.txt')).toBe(PLUGIN_RULES_WORD)
})

// Must fail: without the plugin and with no turn, nothing has written the codeword.
evaluate('plugin rules canary', { environments: closed, tags }, async (c) => {
  expect(await trimmed(c.readFile, 'plugin-codeword.txt')).toBe(PLUGIN_RULES_WORD)
})
