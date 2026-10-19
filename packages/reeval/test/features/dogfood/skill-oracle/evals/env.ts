import { defineEnvironment } from 'reeval'

export const judgeCli = defineEnvironment('cli', ({ directory, file }) => ({
  files: {
    ...directory('../fixtures/common'),
    ...directory('../fixtures/judge'),
    'vendor/reeval.tgz': file('../vendor/reeval.tgz'),
  },
  setup: [{ run: 'npm install --no-audit --no-fund', timeout: '5m' }],
}))
