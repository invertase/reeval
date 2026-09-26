// Builds a golden analysis fixture from a real recorded history: `node trim.mjs <history> <out>`.
// It keeps what the facts layer and the digest read, and shrinks the rest: each record loses long
// final messages (cut at 2 KB, which is more than `attempts.last_text` keeps), each transcript keeps
// every line, so line numbers still match, but only tool calls' targets and short text, and only
// failing attempts keep their judge input and check logs. The records' file refs stay as they were.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const [from, to] = process.argv.slice(2)
if (!from || !to) throw new Error('usage: node trim.mjs <history dir> <fixture dir>')
rmSync(to, { recursive: true, force: true })

const TARGET_KEYS = [
  'path',
  'file_path',
  'filePath',
  'pattern',
  'glob_pattern',
  'command',
  'url',
  'query',
]
const clip = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…` : s)

function trimEvent(event, keepText) {
  if (event.type === 'tool') {
    const input = {}
    for (const key of TARGET_KEYS)
      if (typeof event.input?.[key] === 'string') input[key] = clip(event.input[key], 300)
    return {
      turn: event.turn,
      type: 'tool',
      tool: event.tool,
      input,
      ok: event.ok,
      durationMs: event.durationMs,
    }
  }
  if (event.type === 'text')
    return { turn: event.turn, type: 'text', text: clip(event.text, keepText ? 2000 : 200) }
  if (event.type === 'prompt')
    return { turn: event.turn, type: 'prompt', text: clip(event.text, 600) }
  return { turn: event.turn, type: event.type }
}

const write = (path, content) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

for (const name of readdirSync(from)
  .filter((n) => n.endsWith('.json'))
  .sort()) {
  const record = JSON.parse(readFileSync(join(from, name), 'utf8'))
  const runId = record.runId
  for (const e of record.evals) {
    for (const a of e.attempts) {
      for (const t of a.turns) t.text = clip(t.text, 2000)
      const failed = a.outcome !== 'pass'
      const twin = e.attempts.some((x) => x.cell === a.cell && x.outcome !== 'pass')
      const src = (ref) => join(from, runId, ...ref.path.split('/'))
      const dst = (ref) => join(to, runId, ...ref.path.split('/'))
      if (a.files.transcript) {
        const lines = readFileSync(src(a.files.transcript), 'utf8').split('\n')
        const out = lines.map((line) => {
          if (!line.trim()) return line
          try {
            return JSON.stringify(trimEvent(JSON.parse(line), failed || twin))
          } catch {
            return ''
          }
        })
        write(dst(a.files.transcript), out.join('\n'))
      }
      if (failed && a.files.judgeInput) {
        const inputs = JSON.parse(readFileSync(src(a.files.judgeInput), 'utf8'))
        for (const i of inputs)
          i.state = { task: clip(i.state?.task, 600), output: clip(i.state?.output, 2000) }
        write(dst(a.files.judgeInput), `${JSON.stringify(inputs, null, 1)}\n`)
      }
      for (const c of a.checks) {
        if (failed && c.log)
          write(dst(c.log), readFileSync(src(c.log), 'utf8').split('\n').slice(-40).join('\n'))
      }
    }
  }
  write(join(to, name), `${JSON.stringify(record)}\n`)
}
