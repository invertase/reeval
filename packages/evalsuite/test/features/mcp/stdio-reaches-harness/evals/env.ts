import { defineEnvironment } from 'evalsuite'

/** A stdio MCP server that logs each request it gets to LOG, outside the workspace. */
export const stamp = defineEnvironment('stamp', ({ file, mcp }) => ({
  files: { '~/es-mcp/stamp.mjs': file('../stamp.mjs') },
  mcp: { stamp: mcp.stdio('node', ['/root/es-mcp/stamp.mjs']) },
}))

export const LOG = '/tmp/es-mcp-stamp.log'

export const prompt =
  'Call the house_stamp tool of the stamp MCP server once, and reply with what it returned.'
