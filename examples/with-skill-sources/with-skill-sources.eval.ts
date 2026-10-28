import { defineEnvironment, evaluate, expect } from 'reeval'

const anthropicSkills = 'dbd4588f9e1033efb41dad4bef2f7947c8993d44'

// One skill from each source. Git refs are pinned to a full commit SHA and the npm package to a
// version, so every run gets the same skills.
const skilled = defineEnvironment('four-sources', ({ skill }) => ({
  skills: [
    skill.git('github:anthropics/skills', { ref: anthropicSkills, only: ['brand-guidelines'] }),
    skill.registry('anthropics/skills@doc-coauthoring', { version: anthropicSkills }),
    skill.npm('reeval@0.13.0', { only: ['eval-rubric'] }),
    skill.inline(
      {
        name: 'release-notes',
        description: 'How to write release notes for this project. Use when asked for them.',
        content: 'Release notes are a bulleted list, one line per change, newest first.\n',
      },
      { placement: 'workspace' },
    ),
  ],
}))

evaluate('lists the skills it was given', { environment: skilled }, async (c) => {
  const turn = await c.send(
    'List the names of the skills you have, one per line. Do not change any files.',
  )

  for (const name of ['brand-guidelines', 'doc-coauthoring', 'eval-rubric', 'release-notes']) {
    expect(turn.text, name).toContain(name)
  }
})
