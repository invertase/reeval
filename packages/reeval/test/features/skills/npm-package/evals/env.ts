import { defineEnvironment } from 'reeval'

export const pinned = defineEnvironment('npm-1.2.3', ({ skill }) => ({
  skills: [skill.npm('@acme/skills@1.2.3', { placement: 'workspace' })],
}))

export const staged = '.agents/skills/house-greeting/SKILL.md'
