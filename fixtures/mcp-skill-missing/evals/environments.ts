import { defineEnvironment } from 'reeval'

export const plain = defineEnvironment('plain', {})

export const houseStyle = plain.extendEnvironment('house-style', ({ skill }) => ({
  skills: [skill.local('../skills/house-style')],
}))
