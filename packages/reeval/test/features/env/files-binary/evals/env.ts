import { defineEnvironment } from 'reeval'

// blob.tgz is a gzip that features.test.ts writes before the run: bytes that aren't UTF-8.
export const binaryFile = defineEnvironment('binary-file', ({ file }) => ({
  files: { 'blob.tgz': file('../blob.tgz') },
}))

export const hostBlob = new URL('../blob.tgz', import.meta.url)

/** The file's sha256 in the sandbox. */
export const sandboxSha256 = `node -e "process.stdout.write(require('crypto').createHash('sha256').update(require('fs').readFileSync('blob.tgz')).digest('hex'))"`
