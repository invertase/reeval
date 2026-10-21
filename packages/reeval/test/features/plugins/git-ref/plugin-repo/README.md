Two commits of a plugin repository. `features.test.ts` commits `v1` (tagged `v1`), then `v2` on
`main`, into `repo/`, so `plugin.git` at `ref: 'v1'` must place the older command.

Each changed file differs in size between `v1` and `v2`. On Windows the copy keeps the source's
mtime, so a same-size change would match git's stat cache and `v2` would have nothing to commit.
