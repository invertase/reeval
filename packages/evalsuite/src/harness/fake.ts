import { setTimeout as sleep } from 'node:timers/promises'
import { type ResolvedMcpServer, skillFiles } from '../environment/resolve.ts'
import { InfraError, type Sandbox } from '../sandbox/types.ts'
import type { FakeHarnessDescriptor, TranscriptEvent } from '../types.ts'
import { layoutOf } from './agents.ts'
import type { Harness } from './types.ts'

const lineCount = (text: string) =>
  text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0

/**
 * Writes canned files and returns a canned message on every turn, after running its `script`'s
 * real sandbox actions. Harness-placed skills are written under `~/` where its layout's adapter
 * puts them (`~/.agents/skills` by default, as Cursor's does).
 */
export const createFakeHarness = (descriptor: FakeHarnessDescriptor): Harness => ({
  async start(sandbox, _signal, { skills, workspaceSkills, mcp }) {
    if (descriptor.failWith) throw new InfraError(descriptor.failWith)
    const dir = `~/${layoutOf(descriptor).harnessSkillDir}`
    for (const skill of skills) {
      for (const f of skillFiles(skill)) {
        await sandbox.writeFile(`${dir}/${skill.name}/${f.path}`, f.content)
      }
    }
    const names = [...skills.map((s) => s.name), ...workspaceSkills]
    const loaded = [
      names.length ? `skills: ${names.join(', ')}` : '',
      Object.keys(mcp).length ? `mcp: ${Object.keys(mcp).join(', ')}` : '',
    ].filter(Boolean)
    let calls = 0
    let turns = 0
    const skilled = names.length > 0 && descriptor.withSkill
    const files = (skilled ? descriptor.withSkill?.files : undefined) ?? descriptor.files ?? {}
    const reply = (skilled ? descriptor.withSkill?.text : undefined) ?? descriptor.text ?? 'Done.'
    const flaked = Math.random() < (descriptor.flakeRate ?? 0)
    return {
      async send(prompt, signal) {
        const startedAt = Date.now()
        const script = descriptor.script ?? []
        const steps = script[Math.min(turns++, script.length - 1)] ?? []
        const at = () => {
          const ms = Date.now() - startedAt
          return { ts: new Date(startedAt + ms).toISOString(), atMs: ms }
        }
        const transcript: TranscriptEvent[] = [
          { ...at(), type: 'text', text: `Working on: ${prompt}`, durationMs: 0 },
          ...(loaded.length
            ? [
                {
                  ...at(),
                  type: 'text' as const,
                  text: `Loaded ${loaded.join('; ')}`,
                  durationMs: 0,
                },
              ]
            : []),
        ]
        const done = (text: string, status: 'completed' | 'aborted') => ({
          text,
          status,
          startedAt: new Date(startedAt).toISOString(),
          durationMs: Date.now() - startedAt,
          transcript,
        })
        const write = async (path: string, content: string) => {
          const time = at()
          const before = await sandbox.readFile(path)
          await sandbox.writeFile(path, content)
          transcript.push({
            ...time,
            type: 'file-edit',
            toolCallId: `call_${++calls}`,
            path,
            kind: before === null ? 'create' : 'modify',
            added: lineCount(content),
            removed: before === null ? 0 : lineCount(before),
            durationMs: Date.now() - startedAt - time.atMs,
          })
        }
        if (descriptor.reasoning) {
          transcript.push({ ...at(), type: 'reasoning', text: descriptor.reasoning, durationMs: 0 })
        }
        for (const tool of descriptor.tools ?? []) {
          transcript.push({
            ...at(),
            type: 'tool',
            toolCallId: `call_${++calls}`,
            tool: tool.tool,
            input: tool.input,
            output: tool.output,
            ok: tool.ok ?? true,
            durationMs: 0,
          })
        }
        if (flaked) {
          const text = 'I ran out of ideas and left the workspace unchanged.'
          transcript.push({ ...at(), type: 'text', text, durationMs: 0 })
          return done(text, 'completed')
        }
        let scripted: string | undefined
        for (const step of steps) {
          if ('exec' in step) {
            const time = at()
            const r = await sandbox.exec(step.exec, { signal })
            transcript.push({
              ...time,
              type: 'tool',
              toolCallId: `call_${++calls}`,
              tool: 'shell',
              input: { command: step.exec },
              output: r.stdout,
              ok: r.exitCode === 0,
              durationMs: Date.now() - startedAt - time.atMs,
            })
          } else if ('write' in step) {
            for (const [path, content] of Object.entries(step.write)) await write(path, content)
          } else if ('mcp' in step) {
            const time = at()
            const [server = '', tool = ''] = step.mcp.split('/')
            const r = await callMcpTool(sandbox, mcp, server, tool, signal)
            transcript.push({
              ...time,
              type: 'tool',
              toolCallId: `call_${++calls}`,
              tool: `mcp__${server}__${tool}`,
              input: {},
              output: r.output,
              ok: r.ok,
              durationMs: Date.now() - startedAt - time.atMs,
            })
          } else scripted = step.reply
        }
        if (descriptor.delayMs) {
          try {
            await sleep(descriptor.delayMs, undefined, { signal })
          } catch {
            return done('', 'aborted')
          }
        }
        for (const [path, content] of Object.entries(files)) await write(path, content)
        const text = scripted ?? reply
        transcript.push({ ...at(), type: 'text', text, durationMs: 0 })
        return done(text, 'completed')
      },
      async close() {},
    }
  },
})

const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

/**
 * Starts a stdio MCP server in the sandbox, as an agent would, and calls one tool with no
 * arguments: initialize, then the call, with stdin held open a moment so the server can answer.
 */
async function callMcpTool(
  sandbox: Sandbox,
  servers: Record<string, ResolvedMcpServer>,
  name: string,
  tool: string,
  signal: AbortSignal,
): Promise<{ output: string; ok: boolean }> {
  const server = servers[name]
  if (!server) {
    const known = Object.keys(servers)
    throw new InfraError(
      `The fake agent's script calls MCP server "${name}", which the environment doesn't have (it has ${known.length ? known.join(', ') : 'none'})`,
    )
  }
  if (server.transport !== 'stdio') {
    throw new InfraError(
      `The fake agent calls stdio MCP servers only; "${name}" is ${server.transport}`,
    )
  }
  const messages = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'es-fake-agent', version: '1' },
      },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: {} } },
  ].map((m) => q(JSON.stringify(m)))
  const command = [server.command, ...server.args].map(q).join(' ')
  const r = await sandbox.exec(`{ printf '%s\\n' ${messages.join(' ')}; sleep 1; } | ${command}`, {
    signal,
    env: server.env,
  })
  const reply = r.stdout
    .split('\n')
    .flatMap((line) => {
      try {
        return [
          JSON.parse(line) as { id?: number; result?: McpResult; error?: { message: string } },
        ]
      } catch {
        return []
      }
    })
    .find((m) => m.id === 2)
  if (!reply) return { output: r.stderr.trim() || `no reply (exit ${r.exitCode})`, ok: false }
  if (reply.error) return { output: reply.error.message, ok: false }
  const text = (reply.result?.content ?? []).flatMap((c) => (c.type === 'text' ? [c.text] : []))
  return { output: text.join('\n'), ok: !reply.result?.isError }
}

type McpResult = { content?: Array<{ type: string; text: string }>; isError?: boolean }
