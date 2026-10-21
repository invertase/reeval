import { defineEnvironment, type Turn } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

export const pinned = defineEnvironment('review-1.2.3', ({ plugin }) => ({
  sandbox,
  plugins: [plugin.npm('@acme/review-plugin@1.2.3', { only: ['skills', 'mcp'] })],
}))

export const placed = '~/.reeval/plugins/review'

/** What the plugin's MCP tool returned in the turn, or ''. */
export const stamped = (turn: Turn): string =>
  turn.transcript.flatMap((e) =>
    e.type === 'tool' && e.tool === 'mcp__review:docs__house_stamp' ? [String(e.output)] : [],
  )[0] ?? ''
