import { defineEnvironment } from 'reeval'

export const plain = defineEnvironment('plain', {})
export const working = defineEnvironment('working', {})
export const broken = defineEnvironment('broken', {
  setup: [{ run: 'touch ran', cwd: 'nope/dir' }],
})
