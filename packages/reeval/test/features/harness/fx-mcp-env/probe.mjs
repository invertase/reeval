// A tiny MCP stdio server: one tool, `probe`. Each call writes what the server's own environment
// gave it to LOG: the eval's PROBE_WORD, whether PROBE_KEY is a secret's placeholder, and what a
// fetch of PROBE_TARGET through the sandbox's proxy got.
import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const LOG = '/tmp/reeval-fx-probe.txt'
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`)

async function probe() {
  const key = process.env.PROBE_KEY
  const fetched = await fetch(`http://${process.env.PROBE_TARGET}/`, {
    signal: AbortSignal.timeout(10_000),
  })
    .then((r) => r.text())
    .catch((error) => `failed: ${error.cause?.code ?? error.message}`)
  const lines = [
    `word=${process.env.PROBE_WORD ?? 'unset'}`,
    `key=${key === undefined ? 'unset' : /^reeval_secret_/.test(key) ? 'placeholder' : 'other'}`,
    `fetched=${fetched.trim()}`,
  ]
  writeFileSync(LOG, `${lines.join('\n')}\n`)
  return lines.join(', ')
}

createInterface({ input: process.stdin }).on('line', async (line) => {
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
          serverInfo: { name: 'probe', version: '1.0.0' },
        }
      : m.method === 'tools/list'
        ? {
            tools: [
              {
                name: 'probe',
                description: 'Returns what the probe sees.',
                inputSchema: { type: 'object', properties: {} },
              },
            ],
          }
        : m.method === 'tools/call'
          ? { content: [{ type: 'text', text: await probe() }] }
          : {}
  send({ jsonrpc: '2.0', id: m.id, result })
})
