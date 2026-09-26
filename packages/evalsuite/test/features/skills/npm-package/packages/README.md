Two versions of the npm package `@acme/skills`. `features.test.ts` packs each with `npm pack` and
serves them from a local registry (`npm_config_registry`), with `1.2.4` as `latest`, so
`skill.npm` fetches a pinned version without the network.
