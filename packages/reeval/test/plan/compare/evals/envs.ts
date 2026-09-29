import { defineEnvironment } from 'reeval'

export const base = defineEnvironment('base', { env: { MODE: 'base' } })
export const skilled = base.extendEnvironment('skilled', { env: { MODE: 'skilled' } })
export const terse = base.extendEnvironment('terse', { env: { MODE: 'terse' } })
