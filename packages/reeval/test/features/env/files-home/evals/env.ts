import { defineEnvironment } from 'evalsuite'

export const homeFiles = defineEnvironment('home-files', {
  files: { '~/.config/es/hint.txt': 'from home' },
})
