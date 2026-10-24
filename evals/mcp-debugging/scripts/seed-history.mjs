// Builds a fixture's history in the sandbox's workspace: a git repository with a commit per change
// and a recorded reeval run at each, so the agent has a real history to read. It deletes itself
// first, so the agent never sees how the history was made.
// `node seed-history.mjs <task>`, from the workspace.
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'

const task = process.argv[2]
rmSync(process.argv[1], { force: true })

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Robin Field',
  GIT_AUTHOR_EMAIL: 'robin@example.com',
  GIT_COMMITTER_NAME: 'Robin Field',
  GIT_COMMITTER_EMAIL: 'robin@example.com',
}
const sh = (cmd, args) =>
  execFileSync(cmd, args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const git = (...args) => sh('git', args)

/** `reeval run`'s exit code; with `record`, the run is recorded into the history too. */
const run = (record = true) => {
  try {
    sh('node_modules/.bin/reeval', ['run', '--ui', 'plain', ...(record ? ['--record'] : [])])
    return 0
  } catch (error) {
    if (typeof error.status !== 'number' || error.status > 1) throw error
    return 1
  }
}

/** Runs until one fails, then records that one; the flaky check can pass several runs in a row. */
const runUntilFails = () => {
  for (let i = 0; i < 8; i++) {
    if (run(false) === 1) return sh('node_modules/.bin/reeval', ['record', 'latest'])
  }
  throw new Error(`${task}: the flaky check passed 8 runs in a row`)
}

const edit = (path, from, to) => {
  const text = readFileSync(path, 'utf8')
  if (!text.includes(from)) throw new Error(`${task}: ${path} doesn't contain ${from}`)
  writeFileSync(path, text.replace(from, to))
}

let day = 1
const commit = (message) => {
  const date = `2026-09-${String(day++).padStart(2, '0')}T10:00:00Z`
  git('add', '-A')
  sh('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message, '--date', date])
}

// Changes that move nothing: what a busy repository's other commits look like.
const tidy = {
  slug: () =>
    edit('evals/slug.eval.ts', "'replaces runs of other characters'", "'joins words with dashes'"),
  greet: () => edit('evals/greet.eval.ts', "'says hello'", "'greets with hello'"),
  sum: () => edit('evals/sum.eval.ts', 'adds up a list of numbers', 'adds up an array of numbers'),
  chunk: () => edit('evals/chunk.eval.ts', "'cuts with slice'", "'slices the array'"),
  config: () => edit('evals/parse-config.eval.ts', 'reads a JSON config file', 'reads a JSON file'),
  uniq: () => edit('evals/uniq.eval.ts', 'keeping the first', 'keeping first occurrences'),
  pad: () => edit('evals/pad.eval.ts', 'to n characters', 'to a width of n'),
  title: () => edit('evals/title-case.eval.ts', 'capitalises each word', 'capitalises every word'),
  greetAgent: () => edit('agent/src/greet.js', '(name) =>', "(name = 'there') =>"),
  sumAgent: () => edit('agent/src/sum.js', '(a, b) => a + b', '(total, x) => total + x'),
}

/** What the agent stops doing: a change in agent/ breaks one eval without touching any eval. */
const breakAgent = {
  clamp: () =>
    edit('agent/src/clamp.js', 'Math.min(Math.max(n, lo), hi)', '(n < lo ? lo : n > hi ? hi : n)'),
  title: () =>
    edit(
      'agent/src/title-case.js',
      's.replace(/\\b\\w/g, (c) => c.toUpperCase())',
      "s.split(' ').map((w) => w[0].toLocaleUpperCase() + w.slice(1)).join(' ')",
    ),
  pad: () =>
    edit(
      'agent/src/pad.js',
      "String(s).padStart(n, ' ')",
      "' '.repeat(Math.max(0, n - String(s).length)) + s",
    ),
  chunk: () =>
    writeFileSync(
      'agent/src/chunk.js',
      'export const chunk = (xs, n) => {\n  const out = []\n  for (let i = 0; i < xs.length; i += n) out.push(xs.filter((_, j) => j >= i && j < i + n))\n  return out\n}\n',
    ),
  sum: () => edit('agent/src/sum.js', 'xs.reduce((a, b) => a + b, 0)', 'eval(xs.join("+") || "0")'),
  uniq: () =>
    edit('agent/src/uniq.js', '[...new Set(xs)]', 'xs.filter((x, i) => xs.indexOf(x) === i)'),
}
const chunkFixed =
  'export const chunk = (xs, n) =>\n  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n))\n'
const sumFixed = 'export const sum = (xs) => xs.reduce((a, b) => a + b, 0)\n'

/** The report check's wait, shortened below the build's delay: from then on it races. */
const racy = () => edit('evals/report.eval.ts', "c.exec('sleep 1')", "c.exec('sleep 0.2')")

git('init', '-q', '-b', 'main')
const tasks = {
  // A check that turns flaky at one commit, among commits that each touch a few evals.
  'flaky-since': () => {
    commit('add the toolkit evals')
    run()
    const batches = [
      [tidy.slug, tidy.greetAgent],
      [tidy.sum, tidy.chunk],
      [tidy.config],
      [tidy.uniq, tidy.sumAgent],
      [racy, tidy.pad, tidy.title],
      [tidy.greet],
      [() => edit('evals/slug.eval.ts', 'lower-cases a title', 'lower-cases a heading')],
      [() => edit('evals/chunk.eval.ts', 'into arrays of n items', 'into groups of n')],
      [() => edit('evals/pad.eval.ts', 'pads s on the left', 'left-pads s')],
    ]
    batches.forEach((changes, i) => {
      for (const change of changes) change()
      commit(`update evals (batch ${i + 1})`)
      if (changes.includes(racy)) runUntilFails()
      else run()
    })
  },
  // Two runs to compare: the one at the tag and the latest, with fixes, breaks and a long-broken
  // eval in between.
  regression: () => {
    breakAgent.clamp()
    commit('add the toolkit evals')
    run()
    tidy.slug()
    commit('tidy eval labels')
    run()
    breakAgent.chunk()
    commit('agent: refactor helpers (1)')
    run()
    tidy.config()
    commit('update the config eval prompt')
    run()
    git('tag', 'v1.2')
    breakAgent.pad()
    breakAgent.sum()
    commit('agent: refactor helpers (2)')
    run()
    writeFileSync('agent/src/chunk.js', chunkFixed)
    writeFileSync('agent/src/sum.js', sumFixed)
    commit('agent: refactor helpers (3)')
    run()
    breakAgent.uniq()
    tidy.greet()
    commit('agent: refactor helpers (4)')
    run()
  },
  // The latest run fails three evals: one broken from the start, one flaky all along and one new.
  'is-new': () => {
    breakAgent.clamp()
    racy()
    commit('add the toolkit evals')
    run()
    const batches = [
      [tidy.slug],
      [tidy.greetAgent],
      [tidy.sum],
      [tidy.chunk],
      [tidy.config],
      [tidy.uniq],
      [tidy.pad],
    ]
    batches.forEach((changes, i) => {
      for (const change of changes) change()
      commit(`update evals (batch ${i + 1})`)
      // The flaky eval has to have failed before for its failure not to be new.
      if (i === 2) runUntilFails()
      else run()
    })
    breakAgent.title()
    tidy.greet()
    commit('update evals (batch 8)')
    runUntilFails()
  },
  // One failing eval in a run of 82 attempts, after runs where everything passed.
  'big-record': () => {
    commit('add the module evals')
    run()
    edit(
      'evals/modules.eval.ts',
      'small, documented and readable',
      'small, readable and documented',
    )
    commit('reword the module judge question')
    run()
    edit('evals/export.eval.ts', "toHaveFile('lib/export.js'", "toHaveFile('src/export.js'")
    commit('move the export check next to the modules')
    run()
  },
}
if (!tasks[task]) throw new Error(`unknown task ${task}`)
tasks[task]()
commit('record the latest run')
console.log(`${task}: ${git('rev-list', '--count', 'HEAD').trim()} commits`)
