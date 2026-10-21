import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

/** A stdio MCP server that never answers `initialize`, and outlives its stdin. */
export const silent = defineEnvironment('silent', ({ mcp }) => ({
  sandbox,
  mcp: { stamp: mcp.stdio('node', ['-e', 'setInterval(() => {}, 1000)']) },
}))

/** One that answers at once. */
export const quick = defineEnvironment('quick', ({ file, mcp }) => ({
  sandbox,
  files: { 'stamp.mjs': file('../stamp.mjs') },
  mcp: { stamp: mcp.stdio('node', ['stamp.mjs']) },
}))

export const prompt = 'Call the house_stamp tool of the stamp MCP server once.'
