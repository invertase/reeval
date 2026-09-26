// Checks an installed @cursor/sdk still declares the stored-conversation fields the Cursor SDK
// harness's runner reads to recover web calls (packages/harness-cursor-sdk, storedWebCalls and
// storedShapeProblems), key-free, from the protobuf descriptors bundled in the SDK's dist
// (`"WebFetchArgs|1 url 9|2 tool_call_id 9"`). Messages may be declared more than once (in
// different proto packages); one declaration with every field is enough.
//   node cursor-sdk-shape.mjs [sdk dir]   default: ./node_modules/@cursor/sdk
// Prints what's missing and exits 1, or prints the SDK version and exits 0.
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** The fields the runner reads, as snake_case proto names, by message. */
export const READ_FIELDS = {
  ToolCall: [
    'web_fetch_tool_call',
    'web_search_tool_call',
    'tool_call_id',
    'started_at_ms',
    'completed_at_ms',
  ],
  WebFetchToolCall: ['args', 'result'],
  WebSearchToolCall: ['args', 'result'],
  WebFetchArgs: ['url'],
  WebSearchArgs: ['search_term'],
  WebFetchResult: ['success', 'error'],
  WebSearchResult: ['success', 'error'],
}

/** Every declaration of each message in the sources: its field names. */
export function descriptors(sources) {
  const found = new Map()
  for (const source of sources) {
    for (const m of source.matchAll(/"([A-Z][A-Za-z0-9]*)\|([^"]*)"/g)) {
      const fields = m[2]
        .split('|')
        .map((f) => f.split(' ')[1])
        .filter(Boolean)
      found.set(m[1], [...(found.get(m[1]) ?? []), fields])
    }
  }
  return found
}

/** What's missing, as messages; empty when every read field is declared. */
export function shapeProblems(sources) {
  const found = descriptors(sources)
  const problems = []
  for (const [message, fields] of Object.entries(READ_FIELDS)) {
    const declared = found.get(message)
    if (!declared) {
      problems.push(`no ${message} message`)
      continue
    }
    const best = declared
      .map((have) => fields.filter((f) => !have.includes(f)))
      .sort((a, b) => a.length - b.length)[0]
    if (best.length) problems.push(`${message} has no ${best.join(', ')}`)
  }
  return problems
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const dir = resolve(process.argv[2] ?? 'node_modules/@cursor/sdk')
  const dist = join(dir, 'dist/esm')
  const sources = readdirSync(dist)
    .filter((f) => f.endsWith('.js'))
    .map((f) => readFileSync(join(dist, f), 'utf8'))
  const { version } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const problems = shapeProblems(sources)
  if (problems.length) {
    console.error(
      `@cursor/sdk ${version} changed the stored conversation the Cursor SDK harness recovers web calls from:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    )
    process.exit(1)
  }
  console.log(`@cursor/sdk ${version}: every field the runner reads is declared`)
}
