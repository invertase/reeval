import { defineEnvironment } from 'reeval'

export const missing = defineEnvironment('missing', {
  setup: [{ run: 'touch ran', cwd: 'nope/dir' }],
})

export const present = defineEnvironment('present', {
  files: { 'sub/.keep': '' },
  setup: [{ run: 'touch ran', cwd: 'sub' }],
})
