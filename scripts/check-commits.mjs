// Checks Conventional Commits (AGENTS.md, Project rules): the PR title, and every commit in
// BASE..HEAD except merges. `node scripts/check-commits.mjs [base] [head]`; PR_TITLE is optional.
import { execFileSync } from 'node:child_process'

const TYPES = ['feat', 'fix', 'refactor', 'perf', 'test', 'docs', 'build', 'ci', 'chore', 'revert']
const HEADER = new RegExp(`^(${TYPES.join('|')})(\\([a-z0-9][a-z0-9._/-]*\\))?!?: \\S`)

/** Why `header` isn't a Conventional Commit header, or null when it is. */
function problem(header) {
  if (!HEADER.test(header)) {
    return `expected "type(scope): summary" with a type of ${TYPES.join(', ')}`
  }
  if (header.endsWith('.')) return 'the summary has a trailing period'
  return null
}

const [base = 'origin/main', head = 'HEAD'] = process.argv.slice(2)
const failures = []

const title = process.env.PR_TITLE
if (title !== undefined) {
  const why = problem(title)
  if (why) failures.push(`PR title "${title}": ${why}`)
}

const log = execFileSync('git', ['log', '--no-merges', '--format=%h %s', `${base}..${head}`], {
  encoding: 'utf8',
})
const commits = log.split('\n').filter(Boolean)
for (const line of commits) {
  const [sha, ...rest] = line.split(' ')
  const subject = rest.join(' ')
  const why = problem(subject)
  if (why) failures.push(`${sha} "${subject}": ${why}`)
}

if (failures.length > 0) {
  for (const f of failures) console.error(`::error::${f}`)
  console.error(`\n${failures.length} not Conventional Commits. See AGENTS.md, Project rules.`)
  process.exit(1)
}
console.log(
  `${commits.length} commits${title === undefined ? '' : ' and the PR title'} are Conventional Commits`,
)
