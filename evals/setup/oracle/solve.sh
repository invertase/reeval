set -e
# The oracle's second turn: what the setup skill asks for, in each target.
if [ ! -f reeval.config.ts ]; then
  [ -f package.json ] || npm init -y >/dev/null
  if [ -f pnpm-lock.yaml ]; then pnpm add -D ~/reeval.tgz >/dev/null; else PUPPETEER_SKIP_DOWNLOAD=1 npm i -D ~/reeval.tgz --no-audit --no-fund --loglevel=error; fi
  npx reeval init --bare --harness cursor
fi
mkdir -p evals
if [ -d skills/supabase-postgres-best-practices ]; then
  cat > evals/environments.ts <<'EOF'
import { defineEnvironment } from 'reeval'
export const plain = defineEnvironment('plain', { files: { '.gitignore': 'node_modules/\n' } })
export const withSkill = plain.extendEnvironment('with-postgres-skill', ({ skill }) => ({
  skills: [skill.local('../skills/supabase-postgres-best-practices')],
}))
EOF
  cat > evals/foreign-keys.eval.ts <<'EOF'
import { evaluate, expect } from 'reeval'
import { plain, withSkill } from './environments.ts'
evaluate('indexes foreign keys with the Postgres skill', { compare: { control: plain, variants: [withSkill] } }, async (c) => {
  await c.send('Write migrations/001_orders.sql creating customers and orders, orders.customer_id referencing customers.')
  const sql = ((await c.readFile('migrations/001_orders.sql')) ?? '').toLowerCase()
  expect(sql, 'indexes orders.customer_id').toMatch(/create index[^;]*on\s+orders\s*\(\s*customer_id/)
})
EOF
elif [ -d skills/firestore-rules-creation ]; then
  cat > evals/firestore-rules.eval.ts <<'EOF'
import { defineEnvironment, evaluate, expect } from 'reeval'
const plain = defineEnvironment('plain', {})
const withSkill = plain.extendEnvironment('with-rules-skill', ({ skill }) => ({
  skills: [skill.local('../skills/firestore-rules-creation')],
}))
evaluate('locks down Firestore rules with the rules skill', { compare: { control: plain, variants: [withSkill] } }, async (c) => {
  await c.send('Write firestore.rules so each user can read and write only their own users/{uid} document.')
  const rules = (await c.readFile('firestore.rules')) ?? ''
  expect(rules, 'checks request.auth.uid').toMatch(/request\.auth\.uid\s*==\s*uid/)
})
EOF
elif [ -f GEMINI.md ]; then
  cat > evals/environments.ts <<'EOF'
import { defineEnvironment } from 'reeval'
export const repo = defineEnvironment('firebase-tools', ({ directory }) => ({
  files: directory('..', { glob: ['!.env*', '!.reeval/', '!evals/', '!reeval.config.*', '!GEMINI.md'] }),
  setup: [{ run: 'npm ci --no-audit --no-fund --ignore-scripts', timeout: '10m' }],
}))
export const withRules = repo.extendEnvironment('with-gemini-md', ({ file }) => ({
  rules: file('../GEMINI.md'),
}))
EOF
  cat > evals/projects-list.eval.ts <<'EOF'
import { evaluate, expect } from 'reeval'
import { repo, withRules } from './environments.ts'
evaluate('follows GEMINI.md on a user-facing CLI change', { compare: { control: repo, variants: [withRules] } }, async (c) => {
  await c.send('`firebase projects:list` should say how to create a project when the account has none.')
  expect(c, 'a CHANGELOG.md entry').toHaveChanged('CHANGELOG.md')
  await expect(c.exec('npx tsc --noEmit -p tsconfig.json'), 'compiles').toSucceed()
})
EOF
else
  npm view tailwindcss version
  cat > evals/tailwind.eval.ts <<'EOF'
import { defineEnvironment, evaluate, expect } from 'reeval'
const vite = defineEnvironment('vite', { files: { 'package.json': '{ "type": "module" }\n' } })
evaluate('sets up Tailwind CSS v4 with its CSS import', { environments: vite }, async (c) => {
  await c.send('Add Tailwind CSS 4 to this project, with src/styles.css as the stylesheet.')
  const css = (await c.readFile('src/styles.css')) ?? ''
  expect(css, 'uses @import "tailwindcss"').toMatch(/@import\s+["']tailwindcss["']/)
  expect(css, 'no v3 @tailwind directives').not.toMatch(/@tailwind\s+base/)
})
EOF
fi
npx reeval run --dry-run >/dev/null
npx reeval doctor || true
