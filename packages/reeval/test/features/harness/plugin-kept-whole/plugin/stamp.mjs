// A tiny MCP stdio server: one tool, `house_stamp`. It logs each request's method to a marker
// file, so a check can see that an MCP client really called it.
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const LOG = join(tmpdir(), 'reeval-plugin-stamp.log')
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
          : {}
  send({ jsonrpc: '2.0', id: m.id, result })
})
