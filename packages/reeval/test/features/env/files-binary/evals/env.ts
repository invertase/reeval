import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

// blob.tgz is a gzip that features.test.ts writes before the run: bytes that aren't UTF-8.
export const binaryFile = defineEnvironment('binary-file', ({ file }) => ({
  sandbox,
  files: { 'blob.tgz': file('../blob.tgz') },
}))

export const hostBlob = new URL('../blob.tgz', import.meta.url)

/** The file's sha256 in the sandbox. */
export const sandboxSha256 = `node -e "process.stdout.write(require('crypto').createHash('sha256').update(require('fs').readFileSync('blob.tgz')).digest('hex'))"`
