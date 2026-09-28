import { defineEnvironment } from 'reeval'

/** A stdio MCP server that logs each request it gets to LOG, outside the workspace. */
export const stamp = defineEnvironment('stamp', ({ file, mcp }) => ({
  files: { '~/reeval-mcp/stamp.mjs': file('../stamp.mjs') },
  mcp: { stamp: mcp.stdio('node', ['/home/es/reeval-mcp/stamp.mjs']) },
}))

export const LOG = '/tmp/reeval-mcp-stamp.log'

export const prompt =
  'Call the house_stamp tool of the stamp MCP server once, and reply with what it returned.'
