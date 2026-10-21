import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

/** A stdio MCP server that answers `initialize` at once, started from the workspace. */
export const stamp = defineEnvironment('stamp', ({ file, mcp }) => ({
  sandbox,
  files: { 'stamp.mjs': file('../stamp.mjs') },
  mcp: { stamp: mcp.stdio('node', ['stamp.mjs']) },
}))

/** The same server name, on a command that exits before it answers `initialize`. */
export const crashing = defineEnvironment('crashing', ({ mcp }) => ({
  sandbox,
  mcp: { stamp: mcp.stdio('node', ['-e', 'process.exit(1)']) },
}))

/** reeval's MCP timer logs each server start here, beside the workspace. */
const LOG = '../mcp-startup.jsonl'

/** How long the turn's first server start took to answer `initialize`, from the timer's log. */
export async function firstStartMs(c: { readFile(path: string): Promise<string | null> }) {
  const [line] = ((await c.readFile(LOG)) ?? '').split('\n')
  const entry = line ? JSON.parse(line) : {}
  return entry.initializedAt === undefined ? null : entry.initializedAt - entry.spawnedAt
}

export const prompt = 'Call the house_stamp tool of the stamp MCP server once.'
