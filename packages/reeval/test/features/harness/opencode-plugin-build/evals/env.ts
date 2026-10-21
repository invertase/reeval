import { defineEnvironment } from 'reeval'
import { docker } from 'reeval/sandbox'

// Docker only: a build runs in an image layer, which the fake sandbox refuses.
export const built = defineEnvironment('built', ({ plugin }) => ({
  sandbox: docker(),
  plugins: [plugin.local('../plugin', { build: 'node src/make.mjs' })],
}))

/** The same plugin with a build that writes nothing, under the same name for the canary's cell. */
export const unbuilt = defineEnvironment('built', ({ plugin }) => ({
  sandbox: docker(),
  plugins: [plugin.local('../plugin', { build: 'node -e 0' })],
}))
