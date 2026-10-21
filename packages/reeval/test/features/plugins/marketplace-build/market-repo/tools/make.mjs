// The built entry's build, from the marketplace's root: only a build that gets the whole
// marketplace finds this file, since it's outside the entry's directory.
import { mkdirSync, writeFileSync } from 'node:fs'

mkdirSync('plugins/built/dist', { recursive: true })
writeFileSync('plugins/built/dist/built.txt', 'built from the acme-tools marketplace\n')
