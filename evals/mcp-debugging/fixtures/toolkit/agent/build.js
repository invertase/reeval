import { mkdirSync, writeFileSync } from 'node:fs'

// Collecting the report takes a moment.
setTimeout(() => {
  mkdirSync('dist', { recursive: true })
  writeFileSync('dist/report.txt', 'ok\n')
}, Math.random() * 400)
