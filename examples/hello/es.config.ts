import { defineConfig } from 'evalsuite'
import { cursor } from 'evalsuite/harness'
import { docker } from 'evalsuite/sandbox'

export default defineConfig({
  include: ['evals/**/*.es.ts'],
  harness: cursor({ model: 'composer-2.5' }),
  sandbox: docker(),
  judge: { model: 'google/gemini-3.8-flash', threshold: 0.8 },
  timeout: '15m',
})
