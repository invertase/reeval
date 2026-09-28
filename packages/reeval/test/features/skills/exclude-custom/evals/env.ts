import { defineEnvironment } from 'reeval'

export const greeting = defineEnvironment('greeting', ({ skill }) => ({
  skills: [
    skill.local('../skills/house-greeting', {
      placement: 'workspace',
      exclude: ['/drafts/', '*.tmp'],
    }),
  ],
}))

export const listStaged = 'cd .agents/skills/house-greeting && find . -type f | LC_ALL=C sort'
