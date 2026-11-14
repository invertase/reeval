// reeval's MCP servers in the shape each harness's adapter forwards to its agent.
import type { OpenCodeMcpServer } from '@reeval/harness-opencode'
import type { PiMcpServer } from '@reeval/harness-pi'
import { AgentError } from '../errors.ts'
import type { ResolvedMcpServer } from '../spec.ts'

/** Codex's `config.toml` `[mcp_servers]` shape. */
export function codexMcpServers(
  servers: Record<string, ResolvedMcpServer>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, s]) => {
      if (s.transport === 'sse') {
        throw new AgentError(
          `Codex has no SSE MCP transport, so it can't use the ${name} server (mcp.sse): use mcp.http or mcp.stdio`,
        )
      }
      return s.transport === 'stdio'
        ? [name, { command: s.command, args: s.args, env: s.env ?? {} }]
        : [name, { url: s.url, http_headers: s.headers ?? {} }]
    }),
  )
}

/** The `.mcp.json` shape. */
export function claudeMcpServers(
  servers: Record<string, ResolvedMcpServer>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, s]) =>
      s.transport === 'stdio'
        ? [name, { type: 'stdio', command: s.command, args: s.args, env: s.env }]
        : [name, { type: s.transport, url: s.url, headers: s.headers }],
    ),
  )
}

/** The Antigravity CLI's `mcp_config.json` shape: remote servers take `serverUrl`, not `url`. */
export function antigravityMcpServers(
  servers: Record<string, ResolvedMcpServer>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, s]) =>
      s.transport === 'stdio'
        ? [name, { command: s.command, args: s.args, env: s.env }]
        : [name, { serverUrl: s.url, headers: s.headers }],
    ),
  )
}

/**
 * A `{env:…}` or `{file:…}` OpenCode would substitute. It runs `\{env:[^}]+\}`, then
 * `\{file:[^}]+\}`, over its whole config text with no escape, so a reference left open at the end
 * of a value runs on into the JSON after it, and only `{env:}` and `{file:}` are left alone.
 */
const OPENCODE_REFERENCE = /\{(?:env|file):(?!\})/

const fieldKey = (key: string) =>
  /^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`

/**
 * The first part of a server OpenCode would substitute, as what the server wouldn't get: its name,
 * a value as `mcp.<name>.<field>`, or an env or header name. Names are in the same config text as
 * values, so they're substituted too; a secret's value is never named.
 */
function openCodeReference(name: string, s: ResolvedMcpServer): string | undefined {
  if (OPENCODE_REFERENCE.test(name)) return 'its name'
  const server = `mcp${fieldKey(name)}`
  const [map, kind, values]: [string, string, Record<string, string>] =
    s.transport === 'stdio' ? ['env', 'env', s.env ?? {}] : ['headers', 'header', s.headers ?? {}]
  const fields: [string, string][] = [
    ...(s.transport === 'stdio'
      ? [
          [`${server}.command`, s.command] as [string, string],
          ...s.args.map((a, i): [string, string] => [`${server}.args[${i}]`, a]),
        ]
      : [[`${server}.url`, s.url] as [string, string]]),
    ...Object.entries(values).flatMap(([k, v]): [string, string][] => [
      [`the ${kind} name ${k} in ${server}.${map}`, k],
      [`${server}.${map}${fieldKey(k)}`, v],
    ]),
  ]
  return fields.find(([, text]) => OPENCODE_REFERENCE.test(text))?.[0]
}

/**
 * OpenCode's config shape (its `mcp.servers`), which the adapter sets `codemode: false` on.
 * OpenCode has no SSE transport, and refuses a value it would substitute.
 */
export function opencodeMcpServers(
  servers: Record<string, ResolvedMcpServer>,
): Record<string, OpenCodeMcpServer> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, s]): [string, OpenCodeMcpServer] => {
      if (s.transport === 'sse') {
        throw new AgentError(
          `OpenCode has no SSE MCP transport, so it can't use the ${name} server (mcp.sse): use mcp.http or mcp.stdio`,
        )
      }
      const field = openCodeReference(name, s)
      if (field) {
        throw new AgentError(
          `OpenCode substitutes {env:…} and {file:…} anywhere in its config, with no escape, so the ${name} server wouldn't get ${field} as written: take the reference out, or leave OpenCode out of this cell`,
        )
      }
      return s.transport === 'stdio'
        ? [name, { type: 'local', command: [s.command, ...s.args], environment: s.env ?? {} }]
        : [name, { type: 'remote', url: s.url, headers: s.headers ?? {}, oauth: false }]
    }),
  )
}

/**
 * The key Goose keeps an extension by (its `name_to_key`): whitespace dropped, anything but ASCII
 * letters, digits, `_` and `-` made `_`, lower-cased. Of two extensions with one key it keeps one.
 */
const gooseKey = (name: string) =>
  name
    .replace(/\s/g, '')
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .toLowerCase()

/** Goose's extension shape (its `config.yaml`); it has no SSE transport. */
export function gooseMcpServers(
  servers: Record<string, ResolvedMcpServer>,
): Record<string, Record<string, unknown>> {
  const byKey = new Map<string, string>()
  for (const name of Object.keys(servers)) {
    const key = gooseKey(name)
    const other = byKey.get(key)
    if (other !== undefined) {
      throw new AgentError(
        `Goose keys the ${other} and ${name} MCP servers both as ${key}, and keeps only one: rename one`,
      )
    }
    byKey.set(key, name)
  }
  return Object.fromEntries(
    Object.entries(servers).map(([name, s]) => {
      if (s.transport === 'sse') {
        throw new AgentError(
          `Goose has no SSE MCP transport, so it can't use the ${name} server (mcp.sse): use mcp.http or mcp.stdio`,
        )
      }
      return s.transport === 'stdio'
        ? [name, { type: 'stdio', cmd: s.command, args: s.args, envs: s.env ?? {} }]
        : [name, { type: 'streamable_http', uri: s.url, headers: s.headers ?? {} }]
    }),
  )
}

/**
 * pi's `mcp.json` shape, which the adapter escapes and sets `"exposure": "direct"` on. pi
 * skips a server whose name isn't letters, digits, `_` and `-`, so the plan refuses it instead.
 * A plugin's server, `<plugin>:<server>`, is named `<plugin>_<server>`, so its tools are
 * `mcp__<plugin>_<server>__<tool>`.
 */
export function piMcpServers(
  servers: Record<string, ResolvedMcpServer>,
): Record<string, PiMcpServer> {
  const named = new Map<string, string>()
  return Object.fromEntries(
    Object.entries(servers).map(([key, s]): [string, PiMcpServer] => {
      const name = /^[a-z0-9-]+:[^:]+$/.test(key) ? key.replace(':', '_') : key
      if (!/^[A-Za-z0-9_-]+$/.test(name)) {
        throw new AgentError(
          `pi takes MCP server names of letters, digits, "_" and "-" only, so it can't use the ${key} server: rename it`,
        )
      }
      const other = named.get(name)
      if (other) {
        throw new AgentError(
          `pi names the ${key} MCP server ${name}, as it does the ${other} server, and keeps only one: rename one`,
        )
      }
      named.set(name, key)
      if (s.transport === 'sse') {
        throw new AgentError(
          `pi has no SSE MCP transport, so it can't use the ${key} server (mcp.sse): use mcp.http or mcp.stdio`,
        )
      }
      return s.transport === 'stdio'
        ? [name, { command: s.command, args: s.args, env: s.env ?? {} }]
        : [name, { url: s.url, headers: s.headers ?? {} }]
    }),
  )
}

/**
 * ACP's `McpServer` shape, which fx and Grok Build take on `session/new`: `env` and `headers` as
 * name-value lists.
 */
export function acpMcpServers(
  servers: Record<string, ResolvedMcpServer>,
): Record<string, Record<string, unknown>> {
  const pairs = (values: Record<string, string> = {}) =>
    Object.entries(values).map(([name, value]) => ({ name, value }))
  return Object.fromEntries(
    Object.entries(servers).map(([name, s]) =>
      s.transport === 'stdio'
        ? // `harness-acp` takes only an absolute command, so a bare one goes through `env`'s PATH lookup.
          [
            name,
            s.command.startsWith('/')
              ? { command: s.command, args: s.args, env: pairs(s.env) }
              : { command: '/usr/bin/env', args: [s.command, ...s.args], env: pairs(s.env) },
          ]
        : [name, { type: s.transport, url: s.url, headers: pairs(s.headers) }],
    ),
  )
}

/** fx's ACP `session/new` servers: its `initialize` reports `mcpCapabilities.sse: false`. */
export function fxMcpServers(
  servers: Record<string, ResolvedMcpServer>,
): Record<string, Record<string, unknown>> {
  for (const [name, s] of Object.entries(servers)) {
    if (s.transport === 'sse') {
      throw new AgentError(
        `fx has no SSE MCP transport, so it can't use the ${name} server (mcp.sse): use mcp.http or mcp.stdio`,
      )
    }
  }
  return acpMcpServers(servers)
}

/** The Cursor SDK's `McpServerConfig` shape. */
export function cursorMcpServers(
  servers: Record<string, ResolvedMcpServer>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, s]) =>
      s.transport === 'stdio'
        ? [name, { type: 'stdio', command: s.command, args: s.args, env: s.env }]
        : [name, { type: s.transport, url: s.url, headers: s.headers }],
    ),
  )
}
