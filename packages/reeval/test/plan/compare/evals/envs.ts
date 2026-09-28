import { defineEnvironment } from 'reeval'

export const base = defineEnvironment('base', { env: { MODE: 'base' } })
export const skilled = base.extend('skilled', { env: { MODE: 'skilled' } })
export const terse = base.extend('terse', { env: { MODE: 'terse' } })
