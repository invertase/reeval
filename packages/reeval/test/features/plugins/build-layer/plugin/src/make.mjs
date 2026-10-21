// The plugin's build: writes dist/built.txt, which only exists once the build has run.
import { mkdirSync, writeFileSync } from 'node:fs'

mkdirSync('dist', { recursive: true })
writeFileSync('dist/built.txt', `built on ${process.platform} as uid ${process.getuid?.()}\n`)
