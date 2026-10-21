import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

export const house = defineEnvironment('house', ({ plugin }) => ({
  sandbox,
  plugins: [plugin.local('../plugin')],
}))

/** What real Cursor is asked; only the plugin's rule says what to do. */
export const prompt = 'What is the house codeword? Follow your rules for it, then stop.'

/** The trimmed file, or null when it's missing. */
export const trimmed = async (read: (path: string) => Promise<string | null>, path: string) =>
  (await read(path))?.trim() ?? null
