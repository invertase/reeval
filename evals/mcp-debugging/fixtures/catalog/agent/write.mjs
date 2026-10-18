import { mkdirSync, writeFileSync } from 'node:fs'
import { MODULES } from './modules.mjs'

mkdirSync('src', { recursive: true })
for (const name of MODULES) {
  writeFileSync(`src/${name}.js`, `/** The ${name} module. */\nexport const ${name} = []\n`)
}
mkdirSync('lib', { recursive: true })
writeFileSync(
  'lib/export.js',
  'export const toCsv = (rows) => rows.map((r) => r.join(",")).join("\\n")\n',
)
