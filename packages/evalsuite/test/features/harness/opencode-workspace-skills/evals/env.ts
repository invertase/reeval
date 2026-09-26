import { defineEnvironment } from 'evalsuite'

export const greeting = defineEnvironment('greeting', ({ skill }) => ({
  skills: [skill.local('../skills/house-greeting', { placement: 'workspace' })],
}))
