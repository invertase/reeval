// A tiny MCP stdio server with one tool, `house_stamp`: it answers each request at once.
import { createInterface } from 'node:readline'

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`)
createInterface({ input: process.stdin }).on('line', (line) => {
  let m
  try {
    m = JSON.parse(line)
  } catch {
    return
  }
  if (m.id === undefined) return
  const result =
    m.method === 'initialize'
      ? {
          protocolVersion: m.params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'stamp', version: '1.0.0' },
        }
      : m.method === 'tools/call'
        ? { content: [{ type: 'text', text: 'STAMP-7Q' }] }
        : {}
  send({ jsonrpc: '2.0', id: m.id, result })
})
