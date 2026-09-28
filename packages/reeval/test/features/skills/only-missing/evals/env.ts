import { defineEnvironment } from 'reeval'

export const typo = defineEnvironment('typo', ({ skill }) => ({
  skills: [skill.local('../skills', { only: ['house-greting'], placement: 'workspace' })],
}))

export const picked = defineEnvironment('picked', ({ skill }) => ({
  skills: [skill.local('../skills', { only: ['house-greeting'], placement: 'workspace' })],
}))
