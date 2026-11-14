// Where each agent reads skills, as plain data. `LAYOUTS` in layouts.ts takes these, and the tool-call
// classifier reads them in the studio view too, so this module imports nothing: it runs alike in any
// JavaScript runtime.

/** One agent's skill directories. */
export type SkillLayout = {
  /** The repo skill directory for `placement: 'workspace'`, relative to the workspace. */
  readonly workspaceSkillDir: string
  /** Where the adapter puts harness-placed skills, under `~/`; the fake agent writes them there. */
  readonly harnessSkillDir: string
  /** Other skill directories the agent reads, in the workspace and under `~/`, that reeval never places into. */
  readonly alsoReadsSkillDirs?: readonly string[]
  /** Where the agent CLI keeps the skills it ships with, under `~/`: never an eval's skill use. */
  readonly builtinSkillDirs?: readonly string[]
}

/** Each agent with an image's skill directories, and the fake agent's (`fake`). */
export const SKILL_LAYOUTS = {
  cursor: { workspaceSkillDir: '.cursor/skills', harnessSkillDir: '.agents/skills' },
  'claude-code': { workspaceSkillDir: '.claude/skills', harnessSkillDir: '.claude/skills' },
  // Home skills are ~/.gemini/config/skills, not the ~/.gemini/antigravity-cli path its docs give.
  antigravity: {
    workspaceSkillDir: '.agents/skills',
    harnessSkillDir: '.gemini/config/skills',
    builtinSkillDirs: ['.gemini/antigravity-cli/builtin/skills'],
  },
  // OpenCode also reads .claude/skills and .agents/skills, in the workspace and the home
  // directory; nothing turns that off.
  opencode: {
    workspaceSkillDir: '.opencode/skills',
    harnessSkillDir: '.config/opencode/skills',
    alsoReadsSkillDirs: ['.claude/skills', '.agents/skills'],
  },
  // Goose's bootstrap gives it a private home, so its home skills are under that.
  goose: {
    workspaceSkillDir: '.goose/skills',
    harnessSkillDir: '.ai-sdk-harness/.harness-bootstrap/goose/home/.config/goose/skills',
    alsoReadsSkillDirs: ['.agents/skills', '.claude/skills'],
  },
  pi: { workspaceSkillDir: '.pi/skills', harnessSkillDir: '.pi/agent/skills' },
  codex: { workspaceSkillDir: '.agents/skills', harnessSkillDir: '.agents/skills' },
  fx: {
    workspaceSkillDir: '.fx/skills',
    harnessSkillDir: '.ai-sdk-harness/.harness-bootstrap/fx/home/.fx/skills',
  },
  'grok-build': {
    workspaceSkillDir: '.grok/skills',
    harnessSkillDir: '.ai-sdk-harness/.harness-bootstrap/grok-build/home/.grok/skills',
    alsoReadsSkillDirs: ['.agents/skills', '.claude/skills'],
  },
  fake: { workspaceSkillDir: '.agents/skills', harnessSkillDir: '.agents/skills' },
} as const satisfies Record<string, SkillLayout>

const layouts: readonly SkillLayout[] = Object.values(SKILL_LAYOUTS)

/**
 * Every skill directory some agent reads, as a path's tail (`.claude/skills`, `.config/goose/skills`):
 * a skill under one is the agent's to load, whoever put it there.
 */
export const SKILL_DIRS: readonly string[] = [
  ...new Set(
    layouts.flatMap((l) => [
      l.workspaceSkillDir,
      l.harnessSkillDir.replace(/^\.ai-sdk-harness\/\.harness-bootstrap\/[^/]+\/home\//, ''),
      ...(l.alsoReadsSkillDirs ?? []),
    ]),
  ),
]

/** Every agent CLI's own skill directories (`builtinSkillDirs`), as a path's tail. */
export const BUILTIN_SKILL_DIRS: readonly string[] = [
  ...new Set(layouts.flatMap((l) => l.builtinSkillDirs ?? [])),
]
