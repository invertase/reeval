// Plugin parts a flat agent loads from its own directories, unpacked there from the plugin's
// Claude Code layout. Its skills and MCP servers aren't here: they join the environment's
// harness-placed skills and `mcp`, which the agent already takes.
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { PLUGIN_ROOT, type PluginFile } from '../environment/plugins.ts'
import { InfraError } from '../sandbox/types.ts'
import type { PluginPart } from '../types.ts'

/**
 * Where a flat agent reads each part reeval unpacks, relative to the workspace. Unset parts stay
 * in the plugin's copy only; the agent's `pluginParts` decide which parts it may be given.
 */
export type PluginUnpack = {
  /**
   * The rules directory. Each `rules/<file>.md` or `.mdc` lands as `<plugin>-<file>.mdc`, with
   * `alwaysApply: true` frontmatter when it has none, so it applies as a plugin's rules do.
   */
  rules?: string
  /** The subagents directory: `agents/<name>.md` lands as `<name>.md`. */
  agents?: string
  /** The commands directory: `commands/<name>.md` lands as `<name>.md`. */
  commands?: string
  /**
   * A subagent's or command's YAML frontmatter (`{}` when it has none) as the agent takes it,
   * for an agent whose schema refuses Claude Code's keys; unset, the file lands as it is.
   */
  frontmatter?: (part: 'agents' | 'commands', front: Record<string, unknown>) => object
  /** The hooks file, in Cursor's `hooks.json` shape: `{ version: 1, hooks: { <event>: [...] } }`. */
  hooks?: {
    file: string
    /** Each Claude Code hook event the agent runs, as the agent names it. */
    events: Readonly<Record<string, string>>
    /**
     * A Claude Code group's `matcher` (a tool name pattern) for a Claude Code event, as the agent
     * matches it: undefined for every tool, or null when it names no tool the agent has.
     */
    matcher: (event: string, matcher: string | undefined) => string | null | undefined
  }
}

/** A plugin as the session copied it: its files and the directory `${CLAUDE_PLUGIN_ROOT}` names. */
export type UnpackedPlugin = {
  name: string
  dir: string
  parts: readonly PluginPart[]
  files: readonly PluginFile[]
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

// Editors on Windows may start a file with a byte-order mark, which hides the frontmatter from a
// test anchored at its first character.
const FRONTMATTER = /^\uFEFF?---\r?\n/
const FRONTMATTER_BLOCK = /^\uFEFF?---\r?\n(?:---|([\s\S]*?)\r?\n---)[ \t]*(?:\r?\n|$)/
const RULE = /^rules\/([^/]+)\.mdc?$/
const MARKDOWN = (dir: string) => new RegExp(`^${dir}/([^/]+)\\.md$`)

/** A subagent's or command's Markdown with its frontmatter rewritten by `format`. */
function reformatted(
  text: string,
  part: 'agents' | 'commands',
  what: string,
  format: NonNullable<PluginUnpack['frontmatter']>,
): string {
  const block = FRONTMATTER_BLOCK.exec(text)
  let front: unknown = {}
  if (block) {
    try {
      front = parseYaml(block[1] ?? '') ?? {}
    } catch {
      throw new InfraError(`${what}'s frontmatter isn't valid YAML`)
    }
    if (!isRecord(front)) throw new InfraError(`${what}'s frontmatter isn't a YAML mapping`)
  }
  const body = block
    ? text.slice(block[0].length).replace(/^\r?\n/, '')
    : text.replace(/^\uFEFF/, '')
  const out = format(part, front as Record<string, unknown>)
  const yaml = Object.keys(out).length ? stringifyYaml(out, { lineWidth: 0 }) : ''
  return yaml ? `---\n${yaml}---\n\n${body}` : body
}

/** Cursor's handlers for one plugin's `hooks/hooks.json`, by Cursor's event name. */
function hookHandlers(
  plugin: UnpackedPlugin,
  text: string,
  hooks: NonNullable<PluginUnpack['hooks']>,
): Record<string, unknown[]> {
  const what = `the ${plugin.name} plugin's hooks/hooks.json`
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new InfraError(`${what} isn't valid JSON`)
  }
  const events = isRecord(raw) && isRecord(raw.hooks) ? raw.hooks : {}
  const out: Record<string, unknown[]> = {}
  for (const [event, groups] of Object.entries(events)) {
    const named = hooks.events[event]
    if (!named) throw new InfraError(`${what} has ${event} hooks, which the agent has no event for`)
    for (const group of Array.isArray(groups) ? groups.filter(isRecord) : []) {
      const matcher = hooks.matcher(
        event,
        typeof group.matcher === 'string' ? group.matcher : undefined,
      )
      if (matcher === null) continue
      for (const h of Array.isArray(group.hooks) ? group.hooks.filter(isRecord) : []) {
        if ((h.type ?? 'command') !== 'command' || typeof h.command !== 'string') {
          throw new InfraError(`${what} has a ${event} hook that isn't a command`)
        }
        out[named] ??= []
        out[named].push({
          type: 'command',
          command: h.command.replaceAll(PLUGIN_ROOT, plugin.dir),
          ...(typeof h.timeout === 'number' ? { timeout: h.timeout } : {}),
          ...(matcher === undefined ? {} : { matcher }),
        })
      }
    }
  }
  return out
}

/**
 * The workspace files that give a flat agent the plugins' rules, subagents, commands and hooks,
 * by path relative to the workspace: each part `unpack` names and the plugin keeps, with
 * `${CLAUDE_PLUGIN_ROOT}` filled in with the plugin's `dir`. The hooks of every plugin go in one
 * file, after the handlers of `hooksFile` (the workspace's own, or null).
 */
export function unpackPlugins(
  plugins: readonly UnpackedPlugin[],
  unpack: PluginUnpack,
  hooksFile: string | null = null,
): Array<{ path: string; content: string }> {
  const out: Array<{ path: string; content: string }> = []
  let hooks: Record<string, unknown> | undefined
  for (const plugin of plugins) {
    const keeps = (part: PluginPart, dir: string | undefined): dir is string =>
      dir !== undefined && plugin.parts.includes(part)
    for (const f of plugin.files) {
      const text = () => Buffer.from(f.content).toString('utf8').replaceAll(PLUGIN_ROOT, plugin.dir)
      const rule = RULE.exec(f.path)
      if (rule && keeps('rules', unpack.rules)) {
        const body = text()
        out.push({
          path: `${unpack.rules}/${plugin.name}-${rule[1]}.mdc`,
          content: FRONTMATTER.test(body) ? body : `---\nalwaysApply: true\n---\n\n${body}`,
        })
        continue
      }
      for (const [part, dir] of [
        ['agents', unpack.agents],
        ['commands', unpack.commands],
      ] as const) {
        const name = MARKDOWN(part).exec(f.path)?.[1]
        if (!name || !keeps(part, dir)) continue
        const what = `the ${plugin.name} plugin's ${part === 'agents' ? 'subagent' : 'command'} ${f.path}`
        out.push({
          path: `${dir}/${name}.md`,
          content: unpack.frontmatter
            ? reformatted(text(), part, what, unpack.frontmatter)
            : text(),
        })
      }
      if (f.path === 'hooks/hooks.json' && unpack.hooks && plugin.parts.includes('hooks')) {
        if (!hooks) {
          let own: unknown = {}
          try {
            own = hooksFile === null ? {} : JSON.parse(hooksFile)
          } catch {
            throw new InfraError(
              `The workspace's ${unpack.hooks.file} isn't valid JSON, so reeval can't add the plugins' hooks to it`,
            )
          }
          hooks = isRecord(own) ? { version: 1, ...own } : { version: 1 }
        }
        const merged = isRecord(hooks.hooks) ? { ...hooks.hooks } : {}
        const raw = Buffer.from(f.content).toString('utf8')
        for (const [event, handlers] of Object.entries(hookHandlers(plugin, raw, unpack.hooks))) {
          merged[event] = [...(Array.isArray(merged[event]) ? merged[event] : []), ...handlers]
        }
        hooks.hooks = merged
      }
    }
  }
  if (hooks && unpack.hooks) {
    out.push({ path: unpack.hooks.file, content: `${JSON.stringify(hooks, null, 2)}\n` })
  }
  return out
}
