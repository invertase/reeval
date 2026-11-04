import { isObjectLike } from '../object.ts'
/**
 * Tools that load a skill by name instead of opening `skills/<name>/`: OpenCode's and fx's
 * `skill`, Claude Code's `Skill` and Goose's `load_skill`.
 */
export const SKILL_LOAD_TOOLS = new Set(['skill', 'Skill', 'load_skill'])

/**
 * The skill a dedicated load tool loaded, as the harness named it: OpenCode's `id`, fx's and
 * Goose's `name`, Claude Code's `skill` (`<plugin>:<name>` for a plugin's skill).
 */
export function loadedSkill(tool: string, input: unknown): string | undefined {
  if (!SKILL_LOAD_TOOLS.has(tool) || !isObjectLike(input)) return undefined
  for (const key of ['id', 'name', 'skill']) {
    const value = input[key]
    if (typeof value === 'string') return value
  }
}

/** A tool call's target, uncapped: what `toolTarget` returns before it's cut to 300 characters. */
export function targetText(input: unknown, tool?: string): string {
  if (!isObjectLike(input)) return String(input ?? '')
  const loaded = tool === undefined ? undefined : loadedSkill(tool, input)
  if (loaded !== undefined) return loaded
  for (const key of [
    'path',
    'file_path',
    'filePath',
    'target_file',
    'target_directory',
    'pattern',
    'glob_pattern',
    'command',
    'url',
    'query',
  ]) {
    const value = input[key]
    if (typeof value === 'string') return value
  }
  return JSON.stringify(input)
}

/**
 * A tool call's target: a dedicated skill load's id or name, else its path, pattern,
 * command or URL, else its input, capped.
 */
export function toolTarget(input: unknown, tool?: string): string {
  return targetText(input, tool).slice(0, 300)
}
