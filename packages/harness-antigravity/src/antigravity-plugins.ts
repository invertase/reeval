import { posix } from 'node:path'
import { shellQuote } from '@ai-sdk/harness/utils'

/** Where `agy plugin install` puts each plugin, under the CLI's home: `<dir>/<manifest name>`. */
export const ANTIGRAVITY_PLUGINS_DIR = '.gemini/config/plugins'

/** A Claude Code plugin names its own directory with this in a hook command. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: how a plugin writes the variable
const PLUGIN_ROOT = '${CLAUDE_PLUGIN_ROOT}'

/**
 * The Claude Code hook events the CLI runs, by how it takes their handlers: `flat` events take a
 * list of handlers, `grouped` ones a list of `{ matcher, hooks }` groups. Every other Claude Code
 * event has no Antigravity equivalent.
 */
export const ANTIGRAVITY_HOOK_EVENTS = {
  SessionStart: 'flat',
  PreToolUse: 'grouped',
  PostToolUse: 'grouped',
  Stop: 'flat',
} as const

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * A Claude Code plugin's `hooks/hooks.json` as the CLI's plugin-root `hooks.json`: one named hook,
 * the plugin's, with each event's handlers in the CLI's shape (a tool event's group without a
 * matcher matches every tool) and `${CLAUDE_PLUGIN_ROOT}` in each command filled in with `root`,
 * since the CLI doesn't set it. `agy plugin install` copies the Claude file there unchanged,
 * where the CLI misreads a grouped `SessionStart` and never runs it.
 */
export function antigravityHooks(name: string, claude: unknown, root: string) {
  const events = isRecord(claude) && isRecord(claude.hooks) ? claude.hooks : undefined
  if (!events) throw new Error(`The ${name} plugin's hooks/hooks.json has no hooks object`)
  const handler = (h: unknown) => {
    if (!isRecord(h) || typeof h.command !== 'string' || (h.type ?? 'command') !== 'command') {
      throw new Error(
        `The ${name} plugin has a hook the Antigravity CLI can't run: it runs only command hooks`,
      )
    }
    return {
      type: 'command',
      command: h.command.replaceAll(PLUGIN_ROOT, root),
      ...(typeof h.timeout === 'number' ? { timeout: h.timeout } : {}),
    }
  }
  const out: Record<string, unknown[]> = {}
  for (const [event, groups] of Object.entries(events)) {
    const shape = ANTIGRAVITY_HOOK_EVENTS[event as keyof typeof ANTIGRAVITY_HOOK_EVENTS]
    if (!shape) {
      throw new Error(
        `The ${name} plugin has ${event} hooks, which the Antigravity CLI has no event for`,
      )
    }
    const list = (Array.isArray(groups) ? groups : []).filter(isRecord)
    out[event] =
      shape === 'flat'
        ? list.flatMap((g) => (Array.isArray(g.hooks) ? g.hooks : []).map(handler))
        : list.map((g) => ({
            matcher: typeof g.matcher === 'string' && g.matcher ? g.matcher : '*',
            hooks: (Array.isArray(g.hooks) ? g.hooks : []).map(handler),
          }))
  }
  return { [name]: out }
}

/**
 * Installs a Claude Code plugin with `agy plugin install`, which copies and converts it into
 * {@link ANTIGRAVITY_PLUGINS_DIR}. Then, in the installed copy:
 * - each skill without a `name` is named after its directory (the CLI lists a command it
 *   converted to a skill as `SKILL` otherwise);
 * - each rule without a `trigger` that has no frontmatter, or Cursor's `alwaysApply: true`, gets
 *   `trigger: always_on`, since the CLI leaves a rule without a trigger out.
 */
export function antigravityPluginInstall(cli: string, dir: string, installed: string): string {
  const at = shellQuote(installed)
  return `set -eu
${shellQuote(cli)} plugin install ${shellQuote(dir)}
front() { head -n 1 "$1" | grep -q '^---$'; }
for f in ${at}/skills/*/SKILL.md; do
  [ -f "$f" ] || continue
  grep -q '^name:' "$f" && continue
  skill=$(basename "$(dirname "$f")")
  if front "$f"; then sed -i "1a name: $skill" "$f"; else sed -i "1i ---\\nname: $skill\\n---" "$f"; fi
done
for f in ${at}/rules/*.md ${at}/rules/*.mdc; do
  [ -f "$f" ] || continue
  grep -q '^trigger:' "$f" && continue
  if ! front "$f"; then sed -i '1i ---\\ntrigger: always_on\\n---\\n' "$f"
  elif grep -q '^alwaysApply: *true' "$f"; then sed -i '1a trigger: always_on' "$f"; fi
done`
}

/** Where `agy plugin install` puts the plugin of `name`. */
export const installedPluginDir = (home: string, name: string) =>
  posix.join(home, ANTIGRAVITY_PLUGINS_DIR, name)
