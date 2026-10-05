/** Tools that load a skill by name instead of opening `skills/<name>/`. */
export const SKILL_LOAD_TOOLS = new Set(['skill', 'Skill', 'load_skill'])

/**
 * A tool call's target: a dedicated skill load's id or name, else its path, pattern,
 * command or URL, else its input, capped.
 */
export function toolTarget(input: unknown, tool?: string): string {
  if (typeof input !== 'object' || input === null) return String(input ?? '').slice(0, 300)
  const i = input as Record<string, unknown>
  if (tool && SKILL_LOAD_TOOLS.has(tool)) {
    if (typeof i.id === 'string') return i.id.slice(0, 300)
    if (typeof i.name === 'string') return i.name.slice(0, 300)
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
    if (typeof i[key] === 'string') return (i[key] as string).slice(0, 300)
  }
  return JSON.stringify(input).slice(0, 300)
}
