import { fileURLToPath } from 'node:url'
import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

const repo = `file://${fileURLToPath(new URL('../repo', import.meta.url))}`

export const pinned = defineEnvironment('review-v1', ({ plugin }) => ({
  sandbox,
  plugins: [plugin.git(repo, { ref: 'v1', path: 'plugins/review', only: ['skills', 'commands'] })],
}))

export const placed = '~/.reeval/plugins/review'
