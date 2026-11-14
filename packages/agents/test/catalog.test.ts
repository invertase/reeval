import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HARNESSES } from '../src/catalog/index.ts'
import { LAYOUTS } from '../src/catalog/layouts.ts'
import { SKILL_LAYOUTS } from '../src/catalog/skill-dirs.ts'
import { AgentError } from '../src/errors.ts'
import type { ResolvedMcpServer } from '../src/spec.ts'

const KINDS = Object.keys(HARNESSES) as (keyof typeof HARNESSES)[]

const SERVERS: Record<string, ResolvedMcpServer> = {
  stdio: { transport: 'stdio', command: 'docs', args: ['--port', '1'], env: { A: 'b' } },
  http: { transport: 'http', url: 'https://docs.example/mcp', headers: { A: 'b' } },
  sse: { transport: 'sse', url: 'https://docs.example/sse', headers: { A: 'b' } },
}

test('every harness has a catalog entry, a layout and skill directories', () => {
  assert.deepEqual(KINDS.sort(), Object.keys(LAYOUTS).sort())
  for (const kind of KINDS) {
    assert.ok(SKILL_LAYOUTS[kind], kind)
    const { rulesFile, workspaceSkillDir, harnessSkillDir, pluginPlacement } = HARNESSES[kind]
    assert.deepEqual(
      { rulesFile, workspaceSkillDir, harnessSkillDir, pluginPlacement },
      {
        rulesFile: LAYOUTS[kind].rulesFile,
        workspaceSkillDir: LAYOUTS[kind].workspaceSkillDir,
        harnessSkillDir: LAYOUTS[kind].harnessSkillDir,
        pluginPlacement: LAYOUTS[kind].pluginPlacement,
      },
      kind,
    )
  }
})

test('every harness takes stdio and HTTP MCP servers, and takes SSE or refuses it with an AgentError', () => {
  const refusesSse = ['opencode', 'goose', 'pi', 'codex', 'fx']
  for (const kind of KINDS) {
    const { mcpServers } = HARNESSES[kind]
    for (const name of ['stdio', 'http'] as const) {
      const shaped = mcpServers({ docs: SERVERS[name] as ResolvedMcpServer })
      assert.deepEqual(Object.keys(shaped), ['docs'], `${kind} ${name}`)
    }
    const sse = () => mcpServers({ docs: SERVERS.sse as ResolvedMcpServer })
    if (refusesSse.includes(kind)) {
      assert.throws(sse, (e) => e instanceof AgentError && /no SSE MCP transport/.test(e.message))
    } else assert.deepEqual(Object.keys(sse()), ['docs'], kind)
  }
})
