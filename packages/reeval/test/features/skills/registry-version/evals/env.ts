import { defineEnvironment } from 'reeval'

export const pinned = defineEnvironment('registry-v1', ({ skill }) => ({
  skills: [skill.registry('acme/skills@house-greeting', { version: 'v1', placement: 'workspace' })],
}))

export const staged = '.agents/skills/house-greeting/SKILL.md'
