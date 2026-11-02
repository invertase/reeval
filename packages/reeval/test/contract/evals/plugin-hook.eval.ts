import { evaluate, expect } from 'reeval'
import { closed, PLUGIN_HOOK_MARKER, plugged, prompts, trimmed, withFakePlugin } from './probes.ts'

// The probe plugin's SessionStart hook ran: only it writes the marker. Tagged plugin-hooks too, so
// a harness that loads plugins but not their hooks leaves these out.
const tags = ['plugin', 'plugin-hooks']

evaluate('plugin hook', { environments: plugged, harnesses: withFakePlugin, tags }, async (c) => {
  await c.send(prompts.pluginHook)
  expect(await trimmed(c.readFile, PLUGIN_HOOK_MARKER)).toBe('hook-ran')
})

// Must fail: without the plugin, no hook writes the marker.
evaluate('plugin hook canary', { environments: closed, tags }, async (c) => {
  expect(await trimmed(c.readFile, PLUGIN_HOOK_MARKER)).toBe('hook-ran')
})
