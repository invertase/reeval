// A tiny MCP stdio server: one tool, `house_stamp`. It logs each request's method to a marker
// file, so a check can see that an MCP client really called it.
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const LOG = '/tmp/reeval-mcp-stamp.log'
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`)
createInterface({ input: process.stdin }).on('line', (line) => {
  let m
  try {
    m = JSON.parse(line)
  } catch {
    return
  }
  appendFileSync(
    LOG,
    `${m.method}${m.method === 'initialize' ? ` ${m.params?.clientInfo?.name ?? ''}` : ''}\n`,
  )
  if (m.id === undefined) return
  const result =
    m.method === 'initialize'
      ? {
          protocolVersion: m.params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'stamp', version: '1.0.0' },
        }
      : m.method === 'tools/list'
        ? {
            tools: [
              {
                name: 'house_stamp',
                description: 'Returns the house stamp.',
                inputSchema: { type: 'object', properties: {} },
              },
            ],
          }
        : m.method === 'tools/call'
          ? { content: [{ type: 'text', text: 'STAMP-7Q' }] }
          : undefined
  // Unknown methods get JSON-RPC's "method not found", which is how a client probing a newer
  // handshake (Goose 1.54.0 tries `server/discover` first) knows to fall back to `initialize`.
  send(
    result
      ? { jsonrpc: '2.0', id: m.id, result }
      : {
          jsonrpc: '2.0',
          id: m.id,
          error: { code: -32601, message: `Method not found: ${m.method}` },
        },
  )
})
