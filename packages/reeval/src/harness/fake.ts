import { randomBytes } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { shellQuote as q } from '@reeval/sandbox-docker/process'
import { debugLog } from '../debug/attempt.ts'
import { type ResolvedMcpServer, skillFiles } from '../environment/resolve.ts'
import type { DockerSandbox } from '../sandbox/docker.ts'
import { InfraError, type Sandbox } from '../sandbox/types.ts'
import type { FakeHarnessDescriptor, TranscriptEvent } from '../types.ts'
import { AGENTS, agentMcp, keyRejected, layoutOf, writePluginFiles } from './agents.ts'
import type { Harness } from './types.ts'

const lineCount = (text: string) =>
  text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0

/**
 * Writes canned files and returns a canned message on every turn, after running its `script`'s
 * real sandbox actions. Harness-placed skills are written under `~/` where its layout's adapter
 * puts them (`~/.agents/skills` by default, as Cursor's does). Plugins are already copied under
 * `~/.reeval/plugins/`; where its layout takes plugin items flat, their skills arrive in `skills`.
 * Where it takes them namespaced, it writes its layout's plugin files (Claude Code's settings)
 * and leaves the plugins' MCP servers to the plugins, as that agent does.
 */
export const createFakeHarness = (descriptor: FakeHarnessDescriptor): Harness => {
  let starts = 0
  return {
    async start(sandbox, _signal, { skills, workspaceSkills, mcp: all, plugins }) {
      if (descriptor.failWith) throw new InfraError(descriptor.failWith)
      const hangs = descriptor.startHangs
      // A start that never settles, abort or not, like an agent stuck in its bootstrap.
      if (hangs === true || starts++ < (hangs ?? 0)) return new Promise<never>(() => {})
      const layout = layoutOf(descriptor)
      const brokered = descriptor.brokers ? await brokerKey(descriptor, sandbox) : undefined
      const mcp = agentMcp(layout, all, plugins)
      for (const path of await writePluginFiles(sandbox, layout, plugins)) {
        debugLog('env', `plugin settings → ${path} by the fake agent`)
      }
      const dir = `~/${layout.harnessSkillDir}`
      for (const skill of skills) {
        for (const f of skillFiles(skill)) {
          await sandbox.writeFile(`${dir}/${skill.name}/${f.path}`, f.content)
        }
        debugLog('env', `skill ${skill.name} placed at ${dir}/${skill.name}/ by the fake agent`)
      }
      const names = [...skills.map((s) => s.name), ...workspaceSkills]
      const loaded = [
        names.length ? `skills: ${names.join(', ')}` : '',
        plugins.length
          ? `plugins: ${plugins.map((p) => `${p.name} (${p.parts.join(', ')})`).join(', ')}`
          : '',
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
          const done = (text: string, status: 'completed' | 'aborted' | 'error') => ({
            text,
            status,
            startedAt: new Date(startedAt).toISOString(),
            durationMs: Date.now() - startedAt,
            transcript,
            usage: null,
            model: descriptor.servedModel ?? null,
            unreported: [],
          })
          const write = async (path: string, content: string) => {
            const time = at()
            const before = await sandbox.readFile(path)
            await sandbox.writeFile(path, content)
            debugLog('harness', `tool write ${path} (${before === null ? 'create' : 'modify'})`)
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
            transcript.push({
              ...at(),
              type: 'reasoning',
              text: descriptor.reasoning,
              durationMs: 0,
            })
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
              debugLog('harness', `tool shell called: $ ${step.exec}`)
              const r = await sandbox.exec(step.exec, {
                signal,
                ...(brokered && { env: brokered }),
              })
              debugLog(
                'harness',
                `tool shell returned exit ${r.exitCode} in ${Date.now() - startedAt - time.atMs}ms`,
              )
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
              debugLog('harness', `tool mcp__${server}__${tool} called`)
              const r = await callMcpTool(sandbox, mcp, server, tool, signal)
              debugLog('harness', `tool mcp__${server}__${tool} ${r.ok ? 'returned' : 'failed'}`)
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
            } else if ('error' in step) {
              debugLog('harness', `turn failed: ${step.error}`)
              transcript.push({ ...at(), type: 'error', message: step.error })
              return done('', 'error')
            } else if ('refuseKey' in step) {
              const message = `${keyRejected(step.refuseKey)}. 401 Unauthorized (the fake agent's)`
              debugLog('harness', `turn failed: ${message}`)
              transcript.push({ ...at(), type: 'error', message })
              return { ...done('', 'error'), rejectedKey: message }
            } else scripted = step.reply
          }
          if (descriptor.delayMs) {
            try {
              await sleep(descriptor.delayMs, undefined, descriptor.ignoreAbort ? {} : { signal })
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
  }
}

/**
 * Has the egress gateway swap the host's key for a placeholder on the hosts of the agent's
 * endpoints, as a real adapter does, and returns the variable its `exec` steps get it in.
 */
async function brokerKey(
  descriptor: FakeHarnessDescriptor,
  sandbox: Sandbox,
): Promise<Record<string, string>> {
  const { credential, endpoints } = AGENTS[descriptor.layout ?? 'cursor']
  const key = process.env[credential]
  if (!key) {
    throw new InfraError(
      `${credential} isn't set, so the fake agent has no key to broker. Set it in the environment or .env.local.`,
    )
  }
  const network = 'network' in sandbox ? (sandbox as DockerSandbox).network : undefined
  if (!network?.setRequestTransformations) {
    throw new InfraError("fakeHarness({ brokers: true }) needs docker(): this sandbox can't broker")
  }
  const placeholder = `reeval_fake_${randomBytes(24).toString('base64url')}`
  await network.setRequestTransformations(
    [...new Set(endpoints.map((e) => e.host))].map((host) => ({
      match: {
        host,
        headers: [{ key: { exact: 'authorization' }, value: { exact: `Bearer ${placeholder}` } }],
      },
      transform: { headers: { authorization: `Bearer ${key}` } },
    })),
  )
  debugLog(
    'harness',
    `${credential} is a placeholder for the fake agent, brokered on its endpoints`,
  )
  return { [credential]: placeholder }
}

/**
 * Starts a stdio MCP server in the sandbox, as an agent would, and calls one tool with no
 * arguments: initialize, then the call.
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
        clientInfo: { name: 'reeval-fake-agent', version: '1' },
      },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: {} } },
  ].map((m) => q(JSON.stringify(m)))
  const command = [server.command, ...server.args].map(q).join(' ')
  // stdin stays open until the call's reply is out (or the server exits, or 90s pass, past the MCP
  // timer's 60s, which would log an earlier close as the client leaving rather than a timeout): a server
  // may drop requests it hasn't answered when stdin closes. A pipeline rather than a FIFO, which
  // Git for Windows' sh can't hand to a native server.
  // A server may exit before reading (a crash): the writer ignores SIGPIPE and drops the write's
  // error, and the client still reports the server's stderr. Only the writer ignores SIGPIPE, so
  // the server keeps its own handling. `out` exists before the server starts, so the wait loop
  // never reads a missing file.
  const script = [
    'd=$(mktemp -d) && : > "$d/out" && : > "$d/err" || exit 1',
    '{',
    "  trap '' PIPE",
    `  printf '%s\\n' ${messages.join(' ')} 2>/dev/null`,
    '  i=0',
    `  while [ $i -lt 900 ] && [ ! -f "$d/code" ] && ! grep -Eq '"id": ?2[,}]' "$d/out"; do sleep 0.1; i=$((i + 1)); done`,
    `} | { ${command} > "$d/out" 2> "$d/err"; echo $? > "$d/code"; }`,
    'code=$(cat "$d/code")',
    'cat "$d/out"; cat "$d/err" >&2; rm -rf "$d"; exit $code',
  ].join('\n')
  const r = await sandbox.exec(script, { signal, env: server.env })
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
