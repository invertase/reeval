import { defineEnvironment } from 'reeval'

export const missing = defineEnvironment('missing', {
  setup: [{ run: 'touch ran', cwd: 'nope/dir' }],
})
