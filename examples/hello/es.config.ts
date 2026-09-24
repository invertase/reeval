import { cursor, defineConfig, docker } from 'evalsuite'

export default defineConfig({
  include: ['evals/**/*.es.ts'],
  harness: cursor({ model: 'composer-2.5' }),
  sandbox: docker(),
  judge: { model: 'gemini-3.8-flash' },
  timeout: '15m',
})
