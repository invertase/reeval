import { defineEnvironment } from 'reeval'

/** Named compare arms omit sandbox so they inherit the config environment's. */
export const plain = defineEnvironment('plain', {})
export const skilled = defineEnvironment('skilled', { env: { MODE: 'x' } })
