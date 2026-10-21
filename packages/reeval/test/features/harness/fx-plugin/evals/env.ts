import { defineEnvironment, type Turn } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

export const house = defineEnvironment('house', ({ plugin }) => ({
  sandbox,
  plugins: [plugin.local('../plugin')],
}))

/** What the fake agent says it loaded: its skills, plugins and MCP servers. */
export const loaded = (turn: Turn) =>
  turn.transcript.flatMap((e) =>
    e.type === 'text' && e.text.startsWith('Loaded ') ? [e.text] : [],
  )[0] ?? ''

/** The trimmed file, or null when it's missing. */
export const trimmed = async (read: (path: string) => Promise<string | null>, path: string) =>
  (await read(path))?.trim() ?? null
