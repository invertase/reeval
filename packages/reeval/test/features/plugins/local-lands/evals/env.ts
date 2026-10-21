import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

export const review = defineEnvironment('review', ({ plugin }) => ({
  sandbox,
  plugins: [plugin.local('../plugin', { only: ['skills', 'agents', 'mcp'] })],
}))

/** Where the session copies the plugin, under the sandbox's home. */
export const placed = '~/.reeval/plugins/review'
