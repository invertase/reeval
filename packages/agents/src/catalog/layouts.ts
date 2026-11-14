// Where each harness's agent reads rules, skills, MCP servers and plugins.
import type { PlacedPlugin, PluginFile, PluginUnpack, ResolvedMcpServer } from '../spec.ts'
import type { AgentKind } from './entry.ts'
import {
  CURSOR_HOOK_EVENTS,
  CURSOR_PLUGIN_UNPACK,
  claudePluginFiles,
  OPENCODE_PLUGIN_UNPACK,
  PI_PLUGIN_UNPACK,
} from './plugins.ts'
import { SKILL_LAYOUTS, type SkillLayout } from './skill-dirs.ts'

/** Where an agent reads what the environment gives it. */
export type Layout = SkillLayout & {
  /** The workspace file environment `rules` are written to. */
  rulesFile: string
  /**
   * How the agent takes a plugin's items: `flat`, unpacked into the same lists as the
   * environment's skills and MCP servers (so names can clash), or `namespaced` under the
   * plugin's name. A namespaced agent loads a plugin's MCP servers from the plugin itself.
   */
  pluginPlacement: 'flat' | 'namespaced'
  /**
   * Files under `~/` that make the agent load the session's plugins, written before it starts;
   * unset for an agent pointed at them some other way (launch arguments, an install step). One
   * marked `merge` is a JSON object whose keys are merged into the file an environment's `files`
   * may already have put there, rather than replacing it.
   */
  pluginFiles?: (plugins: readonly PlacedPlugin[]) => PluginFile[]
  /**
   * Where a flat agent reads the plugin parts reeval unpacks into the workspace before the
   * snapshot (rules, subagents, commands, hooks); unset for an agent that takes none.
   */
  pluginUnpack?: PluginUnpack
  /** The Claude Code hook events the agent runs from a plugin; unset, every event. */
  pluginHookEvents?: readonly string[]
}

/**
 * The MCP servers the agent is given: all of them, less the plugins' own where it takes plugin
 * items namespaced, since it loads those from the plugin and would otherwise start each twice.
 */
export function agentMcp(
  layout: Layout,
  mcp: Record<string, ResolvedMcpServer>,
  plugins: readonly PlacedPlugin[],
): Record<string, ResolvedMcpServer> {
  if (layout.pluginPlacement !== 'namespaced') return mcp
  const own = new Set(plugins.flatMap((p) => p.servers))
  return Object.fromEntries(Object.entries(mcp).filter(([name]) => !own.has(name)))
}

/** Where each agent with an image reads rules and skills. */
export const LAYOUTS: Record<AgentKind, Layout> = {
  // The SDK loads AGENTS.md and .cursor/skills from the workspace (settingSources `project`) and
  // ~/.agents/skills from home (`user`). Plugin skills join the home ones; the rest of a plugin is
  // unpacked into the workspace's .cursor/, never loaded with settingSources `plugins`, which also
  // fetches the key owner's account plugins.
  cursor: {
    rulesFile: 'AGENTS.md',
    ...SKILL_LAYOUTS.cursor,
    pluginPlacement: 'flat',
    pluginUnpack: CURSOR_PLUGIN_UNPACK,
    pluginHookEvents: Object.keys(CURSOR_HOOK_EVENTS),
  },
  'claude-code': {
    rulesFile: 'CLAUDE.md',
    ...SKILL_LAYOUTS['claude-code'],
    pluginPlacement: 'namespaced',
    pluginFiles: claudePluginFiles,
  },
  // Home skills are ~/.gemini/config/skills, not the ~/.gemini/antigravity-cli path its docs give.
  // Plugins are installed whole with `agy plugin install`, which the adapter runs as it starts.
  antigravity: {
    rulesFile: 'AGENTS.md',
    ...SKILL_LAYOUTS.antigravity,
    pluginPlacement: 'namespaced',
    // The adapter's ANTIGRAVITY_HOOK_EVENTS, which a test holds this to.
    pluginHookEvents: ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop'],
  },
  // OpenCode reads AGENTS.md but not CLAUDE.md. It also reads .claude/skills and .agents/skills, in
  // the workspace and the home directory; nothing turns that off. Plugin skills join the home ones;
  // plugin subagents and commands are unpacked into the workspace's .opencode/. Its own plugins
  // are code modules, never loaded from an environment's plugins.
  opencode: {
    rulesFile: 'AGENTS.md',
    ...SKILL_LAYOUTS.opencode,
    pluginPlacement: 'flat',
    pluginUnpack: OPENCODE_PLUGIN_UNPACK,
  },
  // Goose's bootstrap gives it a private home, so its home skills are under that. It also
  // reads .agents/skills and .claude/skills; nothing turns that off.
  goose: {
    rulesFile: 'AGENTS.md',
    ...SKILL_LAYOUTS.goose,
    pluginPlacement: 'flat',
  },
  // pi reads workspace skills only in a trusted project, which the adapter's --approve makes
  // it; it reads AGENTS.md (or CLAUDE.md, when there's no AGENTS.md). Plugin skills join the home
  // ones and plugin commands are unpacked as the workspace's prompt templates; pi packages (its own
  // plugins, with extension code) are never loaded from an environment's plugins.
  pi: {
    rulesFile: 'AGENTS.md',
    ...SKILL_LAYOUTS.pi,
    pluginPlacement: 'flat',
    pluginUnpack: PI_PLUGIN_UNPACK,
  },
  // Codex reads skills from ~/.agents/skills and the repo's .agents/skills, AGENTS.md from
  // ~/.codex and the workspace.
  codex: {
    rulesFile: 'AGENTS.md',
    ...SKILL_LAYOUTS.codex,
    pluginPlacement: 'namespaced',
  },
  // fx reads AGENTS.md and .fx/skills from the workspace, and ~/.fx/skills from the private home
  // the ACP bootstrap gives it. It has no plugins of its own: plugin skills join its home skills.
  fx: {
    rulesFile: 'AGENTS.md',
    ...SKILL_LAYOUTS.fx,
    pluginPlacement: 'flat',
  },
  // Grok's bootstrap gives it a private home, so its home skills are under that. It reads the
  // workspace's AGENTS.md and skills only in a trusted folder, which the adapter's
  // GROK_FOLDER_TRUST=false makes it; it also reads .agents/skills and .claude/skills.
  'grok-build': {
    rulesFile: 'AGENTS.md',
    ...SKILL_LAYOUTS['grok-build'],
    pluginPlacement: 'namespaced',
  },
}

/** The fake agent's own layout. */
export const FAKE_LAYOUT: Layout = {
  rulesFile: 'AGENTS.md',
  ...SKILL_LAYOUTS.fake,
  pluginPlacement: 'flat',
}
