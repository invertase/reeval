import { defineEnvironment } from 'reeval'

export const plain = defineEnvironment('plain', {})

export const withDocs = plain.extendEnvironment('with-docs', ({ file }) => ({
  files: { 'docs/api.md': file('../docs/api.md') },
}))
