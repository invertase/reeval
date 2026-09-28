Two versions of the npm package `@acme/skills`. `features.test.ts` packs each with `npm pack` into
`vendor/` before the run, so `skill.npm` can name a tarball by a path relative to the file that
declares it.
