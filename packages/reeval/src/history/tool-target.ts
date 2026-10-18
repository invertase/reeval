import { isObjectLike } from '../object.ts'
/** Tools that load a skill by name instead of opening `skills/<name>/`. */
export const SKILL_LOAD_TOOLS = new Set(['skill', 'Skill', 'load_skill'])

/**
 * A tool call's target: a dedicated skill load's id or name, else its path, pattern,
 * command or URL, else its input, capped.
 */
export function toolTarget(input: unknown, tool?: string): string {
  if (!isObjectLike(input)) return String(input ?? '').slice(0, 300)
  if (tool && SKILL_LOAD_TOOLS.has(tool)) {
    for (const key of ['id', 'name', 'skill']) {
      const value = input[key]
      if (typeof value === 'string') return value.slice(0, 300)
    }
  }
  for (const key of [
    'path',
    'file_path',
    'filePath',
    'pattern',
    'glob_pattern',
    'command',
    'url',
    'query',
  ]) {
    const value = input[key]
    if (typeof value === 'string') return value.slice(0, 300)
  }
  return JSON.stringify(input).slice(0, 300)
}
