import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

const repo = new URL('../repo', import.meta.url).href

export const listed = defineEnvironment('review-entry', ({ plugin }) => ({
  sandbox,
  plugins: [plugin.marketplace(`review@${repo}`, { ref: 'v1' })],
}))

export const plugins = '~/.reeval/plugins'
