import { defineEnvironment } from 'evalsuite'

// Relative to this file, like skill.local and file(), not to ES's working directories.
export const vendored = defineEnvironment('npm-vendored', ({ skill }) => ({
  skills: [skill.npm('../vendor/acme-skills-1.2.3.tgz', { placement: 'workspace' })],
}))

export const staged = '.agents/skills/house-greeting/SKILL.md'
