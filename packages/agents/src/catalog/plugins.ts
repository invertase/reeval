// Where each harness's agent reads what reeval unpacks or writes for the session's plugins.
import {
  PLUGIN_DIR,
  PLUGIN_PARTS,
  type PlacedPlugin,
  type PluginFile,
  type PluginPart,
  type PluginUnpack,
} from '../spec.ts'

/** Claude Code's hook events as Cursor names them, as the Cursor SDK converts Claude Code's own. */
export const CURSOR_HOOK_EVENTS: Readonly<Record<string, string>> = {
  SessionStart: 'sessionStart',
  SessionEnd: 'sessionEnd',
  UserPromptSubmit: 'beforeSubmitPrompt',
  PreToolUse: 'preToolUse',
  PostToolUse: 'postToolUse',
  SubagentStop: 'subagentStop',
  PreCompact: 'preCompact',
  Stop: 'stop',
}

/** Claude Code's tool names as Cursor's hooks match them; null for one Cursor has no tool for. */
const CURSOR_HOOK_TOOLS: Readonly<Record<string, string | null>> = {
  Bash: 'Shell',
  Read: 'Read',
  Write: 'Write',
  Edit: 'Write',
  Glob: null,
  Grep: 'Grep',
  WebFetch: 'WebFetch',
  WebSearch: 'WebSearch',
  Task: 'Task',
}

/**
 * A Claude Code hook group's tool matcher as Cursor's, on the tool events only: each name mapped,
 * `mcp__<server>__<tool>` as `MCP:<tool>`; null when it names only tools Cursor lacks.
 */
export function cursorHookMatcher(
  event: string,
  matcher: string | undefined,
): string | null | undefined {
  if (event !== 'PreToolUse' && event !== 'PostToolUse') return undefined
  if (!matcher || matcher === '*') return undefined
  const out: string[] = []
  for (const raw of matcher.split('|')) {
    const name = raw.trim()
    const parts = name.split('__')
    const tool =
      name.startsWith('mcp__') && parts.length >= 3
        ? `MCP:${parts.slice(2).join('__')}`
        : CURSOR_HOOK_TOOLS[name] === undefined
          ? name
          : CURSOR_HOOK_TOOLS[name]
    if (tool && !out.includes(tool)) out.push(tool)
  }
  return out.length ? out.join('|') : null
}

/** Where Cursor reads what reeval unpacks from a plugin, in the workspace (settingSources `project`). */
export const CURSOR_PLUGIN_UNPACK: PluginUnpack = {
  rules: '.cursor/rules',
  agents: '.cursor/agents',
  commands: '.cursor/commands',
  hooks: { file: '.cursor/hooks.json', events: CURSOR_HOOK_EVENTS, matcher: cursorHookMatcher },
}

/**
 * A plugin subagent's or command's frontmatter as OpenCode 2 takes it: the description, and a
 * subagent's `mode`. OpenCode skips a file whose frontmatter its schema refuses, without saying,
 * and Claude Code's `tools: Read, Grep`, `model: sonnet` and `allowed-tools` are such keys.
 */
export function opencodeFrontmatter(
  part: 'agents' | 'commands',
  front: Record<string, unknown>,
): Record<string, string> {
  const d = front.description
  const description =
    typeof d === 'string' || typeof d === 'number' || typeof d === 'boolean' ? String(d) : undefined
  return {
    ...(description ? { description } : {}),
    ...(part === 'agents' ? { mode: 'subagent' } : {}),
  }
}

/** Where OpenCode reads plugin subagents and commands, in the workspace's config directory. */
export const OPENCODE_PLUGIN_UNPACK: PluginUnpack = {
  agents: '.opencode/agents',
  commands: '.opencode/commands',
  frontmatter: opencodeFrontmatter,
}

/**
 * Where pi reads plugin commands, as prompt templates (`/<name>`), in the workspace, which its
 * `--approve` trusts. Its frontmatter takes `description` and `argument-hint`, and ignores the
 * rest of Claude Code's.
 */
export const PI_PLUGIN_UNPACK: PluginUnpack = { commands: '.pi/prompts' }

/**
 * What Claude Code's plugin format bundles, which Grok Build reads too: every part but rules,
 * which neither loads from a plugin.
 */
export const CLAUDE_FORMAT_PARTS: readonly PluginPart[] = PLUGIN_PARTS.filter((p) => p !== 'rules')

/** The marketplace Claude Code's settings name for the session's plugins. */
export const CLAUDE_PLUGIN_MARKETPLACE = 'reeval'

/**
 * Claude Code's settings for the session's plugins: a `directory` marketplace at the directory
 * they were copied to, listing each, and each enabled as `<plugin>@reeval`. Claude Code installs
 * and loads them as it starts, since the bridge leaves every settings source on.
 */
export function claudePluginFiles(plugins: readonly PlacedPlugin[]): PluginFile[] {
  const [first] = plugins
  if (!first) return []
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
  const marketplace = {
    name: CLAUDE_PLUGIN_MARKETPLACE,
    owner: { name: 'reeval' },
    plugins: plugins.map((p) => ({ name: p.name, source: `./${p.name}` })),
  }
  const settings = {
    extraKnownMarketplaces: {
      [CLAUDE_PLUGIN_MARKETPLACE]: {
        source: { source: 'directory', path: first.dir.slice(0, first.dir.lastIndexOf('/')) },
      },
    },
    enabledPlugins: Object.fromEntries(
      plugins.map((p) => [`${p.name}@${CLAUDE_PLUGIN_MARKETPLACE}`, true]),
    ),
  }
  return [
    { path: `${PLUGIN_DIR}/.claude-plugin/marketplace.json`, content: json(marketplace) },
    { path: '~/.claude/settings.json', content: json(settings), merge: true },
  ]
}
