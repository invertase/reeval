import { defineEnvironment } from 'reeval'

/** Named compare arms omit sandbox so they use the root machine, not the config env's. */
export const plain = defineEnvironment('plain', {})
export const skilled = defineEnvironment('skilled', { env: { MODE: 'x' } })
