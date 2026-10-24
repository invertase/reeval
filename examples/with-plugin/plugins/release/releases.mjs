// A stdio MCP server with one tool, next_version, and no dependencies: one JSON-RPC message a
// line on stdin and stdout.
import { createInterface } from 'node:readline'

const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)

createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method } = JSON.parse(line)
  if (method === 'initialize') {
    send({
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'releases', version: '1.0.0' },
      },
    })
  } else if (method === 'tools/list') {
    const tool = {
      name: 'next_version',
      description: 'The version the next release of this project gets.',
      inputSchema: { type: 'object', properties: {} },
    }
    send({ id, result: { tools: [tool] } })
  } else if (method === 'tools/call') {
    send({ id, result: { content: [{ type: 'text', text: '1.3.0' }] } })
  } else if (id !== undefined) {
    // Every request gets an answer, or the client waits for it.
    send({ id, error: { code: -32601, message: `Method not found: ${method}` } })
  }
})
