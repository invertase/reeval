// The oracle agent: applies the known-good answer for whichever task's project it's run in.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const put = (from, to) => {
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(join(here, from), to)
}

if (existsSync('cli.js')) put('../oracle/readme.eval.ts', 'evals/readme.eval.ts')
else if (existsSync('evals/landing.eval.ts'))
  put('compare/landing.eval.ts', 'evals/landing.eval.ts')
else if (existsSync('docs/api.md')) {
  put('fix-config/reeval.config.ts', 'reeval.config.ts')
  put('fix-config/docs.eval.ts', 'evals/docs.eval.ts')
} else if (existsSync('evals/slug.eval.ts')) {
  const eval_ = readFileSync('evals/slug.eval.ts', 'utf8')
  writeFileSync('evals/slug.eval.ts', eval_.replace("'ahoy--ada'", "'ahoy-ada'"))
}
