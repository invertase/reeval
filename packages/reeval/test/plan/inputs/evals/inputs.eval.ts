import { readFileSync } from 'node:fs'
import { defineEnvironment, evaluate } from 'reeval'
import { docker } from 'reeval/sandbox'
import { TASK } from '../lib/task.ts'

// Read while the file loads, as a hidden test or an answer key would be.
const answers = JSON.parse(readFileSync(new URL('../data/answers.json', import.meta.url), 'utf8'))
// The file's own read of a file one environment also places: every eval in it keeps it.
readFileSync(new URL('../data/a.txt', import.meta.url))

const everything = defineEnvironment('everything', ({ directory, file, git, plugin, skill }) => ({
  sandbox: docker({ dockerfile: '../docker/Dockerfile' }),
  workspace: git('../repo'),
  files: {
    'a.txt': file('../data/a.txt'),
    // The .env file reeval loads, placed too: listed under both kinds.
    '.env': file('../.env'),
    ...directory('../project', { into: 'app' }),
  },
  rules: file('../RULES.md'),
  skills: [skill.local('../skills/guide')],
  plugins: [plugin.local('../plugins/tool', { only: ['skills'] })],
}))

evaluate(`${TASK} (${answers.answer})`, { environments: everything }, async () => {})
evaluate('no environment', async () => {})
