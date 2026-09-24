import { defineEnvironment } from 'evalsuite'

/** The house-greeting skill, handed to the agent through its harness's native skills support. */
export const withHouseGreeting = defineEnvironment('with-house-greeting', (env) => {
  env.skill('./skills/house-greeting')
})
