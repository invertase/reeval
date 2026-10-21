import { defineEnvironment, type Turn } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

export const house = defineEnvironment('house', ({ plugin }) => ({
  sandbox,
  plugins: [plugin.local('../plugin')],
  files: {
    '~/.claude/settings.json': JSON.stringify({
      env: { HOUSE: '1' },
      enabledPlugins: { 'other@elsewhere': false },
    }),
  },
}))

/** What the scripted agent's `n`th shell command printed. */
export const shellOutput = (turn: Turn, n: number) =>
  turn.transcript.flatMap((e) => (e.type === 'tool' && e.tool === 'shell' ? [e.output] : []))[n]

/** What the fake agent says it loaded: its skills, plugins and MCP servers. */
export const loaded = (turn: Turn) =>
  turn.transcript.flatMap((e) =>
    e.type === 'text' && e.text.startsWith('Loaded ') ? [e.text] : [],
  )[0] ?? ''
