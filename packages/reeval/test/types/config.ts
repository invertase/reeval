// Compile-time checks of `defineConfig`, run by `pnpm typecheck` (tsconfig.json here): a key the
// config doesn't have is a type error, at the top level, in a profile and from the callback form,
// so a renamed or misspelled option fails `tsc` as well as `reeval run`. An unused
// `@ts-expect-error` fails the build too.

import { fakeHarness } from '../../src/harness.ts'
import { defineConfig, defineEnvironment } from '../../src/index.ts'

const app = defineEnvironment('app', {})

const config = defineConfig({
  harnesses: fakeHarness(),
  environments: app,
  profiles: { smoke: { limit: { harnesses: ['fake'] }, defaults: { runs: 1 } } },
})
const profiles: object | undefined = config.profiles
void profiles
defineConfig(({ secret }) => ({ env: { KEY: secret.fromEnv('KEY') }, environments: [app] }))

// Each sits beside a key the config has, as in a real config: a lone unknown key is refused
// anyway, since every key is optional.
// @ts-expect-error harness is harnesses
defineConfig({ harness: fakeHarness(), runs: 1 })
// @ts-expect-error environment is environments
defineConfig({ environment: app, runs: 1 })
// @ts-expect-error a misspelled key
defineConfig({ harnesess: fakeHarness(), runs: 1 })
defineConfig({
  // @ts-expect-error limit.harness is limit.harnesses
  profiles: { smoke: { limit: { harness: ['fake'], runs: 1 } } },
})
defineConfig({
  // @ts-expect-error defaults.harness is defaults.harnesses
  profiles: { smoke: { defaults: { harness: fakeHarness(), runs: 1 } } },
})
// @ts-expect-error the callback's config is checked too
defineConfig(() => ({ harness: fakeHarness(), runs: 1 }))
