import { readFileSync } from 'node:fs'
import { defineEnvironment, evaluate } from 'reeval'
import { docker } from 'reeval/sandbox'
import { TASK } from '../lib/task.ts'

// Read while the file loads, as a hidden test or an answer key would be.
const answers = JSON.parse(readFileSync(new URL('../data/answers.json', import.meta.url), 'utf8'))

const everything = defineEnvironment('everything', ({ directory, file, git, plugin, skill }) => ({
  sandbox: docker({ dockerfile: '../docker/Dockerfile' }),
  workspace: git('../repo'),
  files: { 'a.txt': file('../data/a.txt'), ...directory('../project', { into: 'app' }) },
  rules: file('../RULES.md'),
  skills: [skill.local('../skills/guide')],
  plugins: [plugin.local('../plugins/tool', { only: ['skills'] })],
}))

evaluate(`${TASK} (${answers.answer})`, { environments: everything }, async () => {})
evaluate('no environment', async () => {})
