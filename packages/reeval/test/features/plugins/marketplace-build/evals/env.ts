import { fileURLToPath, pathToFileURL } from 'node:url'
import { defineEnvironment } from 'reeval'
import { docker } from 'reeval/sandbox'

const repo = pathToFileURL(fileURLToPath(new URL('../repo', import.meta.url))).href

// Docker only: a build runs in an image layer, which the fake sandbox refuses.
export const built = defineEnvironment('built', ({ plugin }) => ({
  sandbox: docker(),
  plugins: [
    plugin.marketplace(`built@${repo}`, {
      ref: 'v1',
      build: { run: 'node tools/make.mjs', cwd: '.' },
    }),
  ],
}))

/** The same entry with a build that writes nothing, under the same name for the canary's cell. */
export const unbuilt = defineEnvironment('built', ({ plugin }) => ({
  sandbox: docker(),
  plugins: [plugin.marketplace(`built@${repo}`, { ref: 'v1', build: 'node -e 0' })],
}))

/** Where the session copies the plugin, under the sandbox's home. */
export const placed = '~/.reeval/plugins/built'
