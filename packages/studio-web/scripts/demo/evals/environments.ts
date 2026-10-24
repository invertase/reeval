import { defineEnvironment } from 'reeval'

/** Empty control for the house-greeting compare. */
export const plain = defineEnvironment('plain', {})

/** The house-greeting skill, layered on `plain` before compare runs the two apart. */
export const withHouseGreeting = plain.extendEnvironment('with-house-greeting', ({ skill }) => ({
  skills: [skill.local('../skills/house-greeting')],
}))
