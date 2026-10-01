import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

/** A stdio MCP server that logs each request it gets to LOG, outside the workspace. */
export const stamp = defineEnvironment('stamp', ({ file, mcp }) => ({
  sandbox,
  files: { '~/reeval-mcp/stamp.mjs': file('../stamp.mjs') },
  mcp: { stamp: mcp.stdio('node', ['/home/reeval/reeval-mcp/stamp.mjs']) },
}))

export const LOG = '/tmp/reeval-mcp-stamp.log'

export const prompt =
  'Call the house_stamp tool of the stamp MCP server once, and reply with what it returned.'
