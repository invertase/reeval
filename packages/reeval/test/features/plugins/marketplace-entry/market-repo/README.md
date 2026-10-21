A Claude Code marketplace listing two plugins. `features.test.ts` commits this directory into
`repo/` and tags it `v1`, so `plugin.marketplace('review@file://…/repo', { ref: 'v1' })` places
the `review` entry and nothing of `lint`.
