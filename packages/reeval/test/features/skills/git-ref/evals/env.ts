import { fileURLToPath } from 'node:url'
import { defineEnvironment } from 'evalsuite'

const repo = `file://${fileURLToPath(new URL('../repo', import.meta.url))}`

export const pinned = defineEnvironment('greeting-v1', ({ skill }) => ({
  skills: [skill.git(repo, { ref: 'v1', path: 'skills', placement: 'workspace' })],
}))

export const staged = '.agents/skills/house-greeting/SKILL.md'
