// The rename from ES (`@invertase/foobar`, CLI `es`) to reeval, as a repeatable codemod. Run it
// on a clean checkout of `main`, from the repository root:
//
//   node scripts/rename.mjs            move and rewrite files, then regenerate what's generated
//   node scripts/rename.mjs --no-regen move and rewrite only
//   node scripts/rename.mjs --check    exit 1 if a rewrite would still change something
//   node --experimental-strip-types scripts/rename.mjs --realign <dir>
//                                      realign the differential captures with a run recorded
//                                      into <dir> (scripts/differential.mjs record)
//
// Regenerating rewrites the goldens and differential captures whose columns the longer names
// move, and fails if one changed beyond the rename. Then `bash scripts/rename-verify.sh`.
// What it leaves alone, on purpose:
// - recorded history (the corpus's `.history` and eval file names, the analysis fixtures and the
//   names tests read from them, the old schema snapshot, captured replays and the Claude Code
//   bridge capture), which an older ES wrote and which must keep loading;
// - persisted identifiers that readers match on: `kind: 'es-run'`, `'es-analysis'`, the anomaly
//   kind `'es-bug'`, the action kind `'es'`, the record field `es` (its version), and the
//   `evalsuite:` salt of `hostHash`;
// - the sandbox's `es` user, `/home/es` and `/es/workspace`, which the captured real-agent
//   streams in test/replay and each harness's test fixtures contain.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const args = new Set(process.argv.slice(2))
const check = args.has('--check')
const realignOnly = process.argv.includes('--realign')
const regen = !args.has('--no-regen') && !check && !realignOnly

const SELF = ['scripts/rename.mjs', 'scripts/rename-verify.sh']
const SKIP = [
  /\/test\/fixtures\/records\/.*\/\.history\//,
  /\/test\/fixtures\/(analysis|schema|claude-code-bridge)\//,
  /\/test\/replay\//,
  /^pnpm-lock\.yaml$/,
  /^CHANGELOG\.md$/,
  /^\.release-please-manifest\.json$/,
]
/**
 * The corpus projects' eval files keep the names their records were made under (their configs
 * include them), so a new run beside an old record is the same eval.
 */
const KEEP_EVAL_NAMES = /\/test\/fixtures\/records\//
/** Tests that read the analysis fixtures, where the recorded environment and eval names stay. */
const READS_ANALYSIS =
  /\/test\/(analysis\.test\.ts|features\/inventory\.ts|differential\/vitest\/analysis\.test\.ts\.jsonl)$/
const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|tgz|gz|zip|wasm)$/i
const COMMANDS =
  'init|doctor|run|clean|record|history|show|compare|checkout|query|analyze|mcp|studio|report|image|help|eval|__worker'

const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 })
const tracked = () => git('ls-files', '-z').split('\0').filter(Boolean)
const skipped = (file) => SELF.includes(file) || SKIP.some((re) => re.test(file))

/** Where a tracked file goes: the package and skill directories, config files and eval files. */
function movedPath(file) {
  let path = file
    .replace(/^packages\/evalsuite\//, 'packages/reeval/')
    .replace(/^\.agents\/skills\/es\//, '.agents/skills/reeval/')
  if (skipped(file)) return path
  const name = basename(path)
  if (KEEP_EVAL_NAMES.test(file) && name.endsWith('.es.ts')) return path
  const renamed = name
    .replace(/^(.+)\.es\.ts$/, '$1.eval.ts')
    .replace(/^es((?:\.[\w-]+)?)\.config\.(ts|mts|cts|js|mjs|cjs)$/, 'reeval$1.config.$2')
  if (renamed !== name) path = join(dirname(path), renamed)
  return path
}

/**
 * Values that look like old names but are persisted or baked into recorded streams, swapped for a
 * sentinel before the rules run and back after.
 */
const PROTECT = [
  [/evalsuite:\$\{hostname\(\)\}/g],
  [/\bes-(?:run|analysis|bug)\b/g],
  [/`es`(?=,? `judge_model`)/g],
  [/`es`(?= user\b| \(uid| \(SANDBOX_USER)/g],
  [/the `es` user/g],
  [/\bas `es`/g],
  [/[\w/*-]+\.es\.ts\b/g, KEEP_EVAL_NAMES],
  [/evals\/compare\.es\.ts/g, READS_ANALYSIS],
  [/evals\\\/greet\\\.es\\\.ts › writes greet/g, /\/test\/history\.test\.ts$/],
]

/** The `es-…` names in the recorded analysis fixtures (environments, cells, slugs). */
function recordedNames() {
  const names = new Set()
  for (const file of tracked().filter((f) => /\/test\/fixtures\/analysis\//.test(f))) {
    if (BINARY.test(file)) continue
    for (const m of readFileSync(join(root, file), 'utf8').matchAll(/\bes-[a-z0-9][a-z0-9-]*/g)) {
      names.add(m[0])
    }
  }
  const sorted = [...names].sort((a, b) => b.length - a.length)
  return sorted.length ? new RegExp(`\\b(?:${sorted.join('|')})(?![\\w-])`, 'g') : null
}

/** The rules, in order: [pattern, replacement, and optionally the only files it applies to]. */
const RULES = [
  [/ES \(Eval Suite\)/g, 'reeval'],
  [/Eval Suite/g, 'reeval'],
  [/@invertase\/foobar/g, 'reeval'],
  [/invertase-foobar/g, 'reeval'],
  [/@evalsuite\//g, '@reeval/'],
  [/invertase\/evalsuite/g, 'invertase/reeval'],
  [/dev(\\*)\.evalsuite(\\*)\./g, 'ai$1.reeval$2.'],
  [/\bevalsuite\b/g, 'reeval'],
  [/\bES_/g, 'REEVAL_'],
  [/(\\*)\.es(\\*)\.ts\b/g, '$1.eval$2.ts'],
  [/\bes(\\*\.)([a-z0-9-]+)(\\*\.)config\b/g, 'reeval$1$2$3config'],
  [/(\b|%2F|%5C)es(\\*\.)config\b/g, '$1reeval$2config'],
  [/(?<![\w-])\.es(?![\w.-])/g, '.reeval'],
  [/(\.agents\/skills\/)es\b/g, '$1reeval'],
  [/\b(npx|bunx|pnpm exec|pnpm|yarn|npm exec --) es(?![\w.:/-])/g, '$1 reeval'],
  [/(\.bin(?:\/|\\+))es\b/g, '$1reeval'],
  [
    new RegExp(
      `\\bes (?=(?:${COMMANDS}|VERSION)\\b|--|-h\\b|-v|\\$\\{|\\[|<|\\d+\\.\\d+\\.\\d+)`,
      'g',
    ),
    'reeval ',
  ],
  [
    /\bes (?=(?:command|commands|CLI|process|binary|you ran|speaks|alone|that runs|project)\b)/g,
    'reeval ',
  ],
  [/\bruns es\b/g, 'runs reeval'],
  [/\boption of es\b/g, 'option of reeval'],
  [/\/\^es \//g, '/^reeval /'],
  [/(\^|\/)es \\S\+ —/g, '$1reeval \\S+ —'],
  [/\bes%20/g, 'reeval%20'],
  [/\['es', '/g, "['reeval', '"],
  [/(['"\s])([\w-]+)\.es(?=['",\s\])])/g, '$1$2.eval', /\/test\//],
  [/"es": \{/g, '"reeval": {', /^docs\/recipes\/agent-mcp\.mdx$/],
  [/`es`/g, '`reeval`'],
  [/(^|[`'"/^[\uE001])es: /gm, '$1reeval: '],
  [/\bes:egress\b/g, 'reeval:egress'],
  [/\bes:\/\//g, 'reeval://'],
  [/\["es", "mcp"/g, '["reeval", "mcp"'],
  [/-es-ts-/g, '-eval-ts-'],
  [/\banalysis-v1\b/g, 'analysis-v2'],
  [/\bes-(?=[a-z0-9])/g, 'reeval-'],
  [/\bes_(?=[a-z])/g, 'reeval_'],
  [/\b(A|a)n ES\b(?! modules?\b)/g, '$1 reeval'],
  [/\bES\b(?! modules?\b)(?!\d)/g, 'reeval'],
  [/\b(A|a)n reeval\b/g, '$1 reeval'],
  // The message is cut at a fixed width, and `reeval` is four characters longer than `ES`.
  [/(blocked by the reeval egress policy: )(?:the |bloc)…/g, '$1…', /\/test\/features\.test\.ts$/],
]

/** Every corpus project's config, before the rename. */
function corpusConfigs() {
  return tracked().filter((f) =>
    /^packages\/evalsuite\/test\/fixtures\/records\/[^/]+\/es\.config\.ts$/.test(f),
  )
}

/**
 * Hand edits the rules can't make, applied to the original text before them. Each `from` must be
 * there (or its `to` already), so a `main` that moved on fails loudly instead of renaming half.
 */
const PATCHES = [
  {
    file: 'packages/evalsuite/package.json',
    from: '"es": "./dist/cli.js"',
    to: '"reeval": "./dist/cli.js",\n    "re": "./dist/cli.js"',
  },
  {
    file: 'examples/hello/package.json',
    from: '"es": "es",',
    to: '"reeval": "reeval",',
  },
  {
    file: 'examples/hello/package.json',
    from: '"evalsuite": "workspace:@invertase/foobar@*"',
    to: '"reeval": "workspace:*"',
  },
  {
    file: 'packages/evalsuite/src/cli-parse.ts',
    from: "new Command('es'), 'es'",
    to: "new Command('reeval'), 'reeval'",
  },
  {
    file: 'packages/evalsuite/src/cli-spec.ts',
    from: `if (words[0] !== 'es') return \`"\${segment}" isn't an es command\``,
    to: `if (words[0] !== 'reeval' && words[0] !== 're')
    return \`"\${segment}" isn't a reeval command\``,
  },
  {
    file: 'packages/evalsuite/src/mcp/server.ts',
    from: "{ name: 'es', title: 'ES run history'",
    to: "{ name: 'reeval', title: 'reeval run history'",
  },
  {
    file: 'packages/evalsuite/test/mcp.test.ts',
    from: "getServerVersion()?.name, 'es')",
    to: "getServerVersion()?.name, 'reeval')",
  },
  {
    file: 'packages/harness-opencode/test/unit.test.ts',
    from: `    'ES_OPENCODE_MCP_SERVERS',
    'OPENCODE_CONFIG_CONTENT',
    'OPENCODE_DISABLE_AUTOUPDATE',
    'OPENCODE_DISABLE_MODELS_FETCH',
  ])`,
    to: `    'OPENCODE_CONFIG_CONTENT',
    'OPENCODE_DISABLE_AUTOUPDATE',
    'OPENCODE_DISABLE_MODELS_FETCH',
    'REEVAL_OPENCODE_MCP_SERVERS',
  ])`,
  },
  ...corpusConfigs().map((file) => ({
    file,
    from: '  sandbox: fakeSandbox(),\n',
    to: "  sandbox: fakeSandbox(),\n  // Its evals keep the names their records were made under.\n  include: ['evals/**/*.es.ts'],\n",
  })),
  {
    file: 'packages/evalsuite/src/analysis/digest.ts',
    from: ".replace(/\\.es\\.ts$|\\.[jt]s$/, '')",
    to: ".replace(/\\.(?:eval|es)\\.ts$|\\.[jt]s$/, '')",
  },
  {
    file: 'README.md',
    from: 'npm i -D @invertase/foobar   # placeholder name; the CLI is `es`',
    to: 'npm i -D reeval   # the CLI is `reeval`, or `re` for short',
  },
  {
    file: 'AGENTS.md',
    from: `The package is published as \`@invertase/foobar\`. That's a placeholder until the final name is
chosen. Code, docs and examples import from \`@invertase/foobar\` and its subpaths \`/harness\`,
\`/sandbox\`, \`/judge\` and \`/view\`. The CLI is \`es\`. Inside this monorepo, \`examples/hello\`
depends on it under the alias \`evalsuite\` (\`"evalsuite": "workspace:@invertase/foobar@*"\`), so
its files import \`evalsuite\`.`,
    to: `The package is published as \`reeval\` ([reeval.ai](https://reeval.ai)). Code, docs and examples
import from \`reeval\` and its subpaths \`/harness\`, \`/sandbox\`, \`/judge\` and \`/view\`. The CLI is
\`reeval\`, with \`re\` as a short alias for typing; docs, help, scripts and examples always say
\`reeval\` (\`npx re\` would fetch an unrelated npm package). Eval files are \`*.eval.ts\`, the
config is \`reeval.config.ts\` and local state is \`.reeval/\`. Inside this monorepo,
\`examples/hello\` depends on it as \`"reeval": "workspace:*"\`.`,
  },
  {
    file: 'AGENTS.md',
    from: `- **\`{{ pkg }}\`, never the package name.** It's set once, in \`docs.json\` \`variables\`, so the rename
  is one line. Frontmatter can't use variables, so titles never name the package.`,
    to: `- **\`{{ pkg }}\` where the docs install or import the package.** It's set once, in \`docs.json\`
  \`variables\`. The brand and the CLI are the same word, \`reeval\`, and are written out.`,
  },
  {
    file: 'AGENTS.md',
    from: '(or a page no link), or when a page names the package literally.',
    to: '(or a page no link), or when a page installs or imports the package by name.',
  },
  {
    file: 'scripts/docs.mjs',
    from: '/^ {2}es ((?:[a-z]+)(?: build)?)\\b/',
    to: '/^ {2}reeval ((?:[a-z]+)(?: build)?)\\b/',
  },
  {
    file: 'scripts/docs.mjs',
    from: `const pkg = config.variables.pkg
for (const file of mdxFiles()) {
  if (!linked.has(file)) problems.push(\`\${relative(root, file)} isn't in the docs.json sidebar\`)
  if (read(file).includes(pkg)) {
    problems.push(
      \`\${relative(root, file)} names \${pkg}: use {{ pkg }} so the name lives in docs.json\`,
    )
  }
}`,
    to: `const pkg = config.variables.pkg
/** The package named where it's installed or imported; the brand and CLI share its name. */
const pkgSpecifier = new RegExp(
  \`(?:from |import\\\\(|require\\\\()['"]\${pkg}(?:/[\\\\w-]+)?['"]|\\\\b(?:npm (?:i|install)|pnpm add|yarn add|bun add)\\\\b[^\\\\n]*\\\\s\${pkg}(?:@\\\\S*)?(?=\\\\s|$)\`,
)
for (const file of mdxFiles()) {
  if (!linked.has(file)) problems.push(\`\${relative(root, file)} isn't in the docs.json sidebar\`)
  if (pkgSpecifier.test(read(file))) {
    problems.push(
      \`\${relative(root, file)} installs or imports \${pkg} by name: use {{ pkg }} so it lives in docs.json\`,
    )
  }
}`,
  },
  {
    file: 'docs/reference/cli.mdx',
    from: 'The `es` CLI ships with the package. Run it with `npx es`, or `pnpm es` in a pnpm project.',
    to: 'The `reeval` CLI ships with the package. Run it with `npx reeval`, or `pnpm reeval` in a pnpm project.\nOnce installed, `re` is the same command, for typing; `npx re` fetches an unrelated package, so\nscripts and docs say `reeval`.',
  },
  {
    file: '.agents/skills/es/SKILL.md',
    from: `name: es
description: >
  How to write, run and debug evals with ES (Eval Suite), the eval runner for coding agents
  (npm package @invertase/foobar, a placeholder name; CLI \`es\`). Use whenever a task mentions ES,
  evalsuite, @invertase/foobar, es.config.ts, *.es.ts files, \`es run\`, evals for a coding agent,
  comparing skills, MCP servers or docs, or lift.`,
    to: `name: reeval
description: >
  How to write, run and debug evals with reeval, the eval runner for coding agents (npm package
  reeval; CLI \`reeval\`, alias \`re\`). Use whenever a task mentions reeval, reeval.config.ts,
  *.eval.ts files, \`reeval run\`, evals for a coding agent, comparing skills, MCP servers or
  docs, or lift.`,
  },
]

/**
 * `reeval` is four characters longer than `es`, so every help line's description column moves
 * from 28 to 32: command lines grow with the rename, the others get four spaces.
 */
function shiftHelpColumns(text) {
  let inHelp = false
  return text
    .split('\n')
    .map((line) => {
      if (/help: `$/.test(line)) {
        inHelp = true
        return line
      }
      if (!inHelp) return line
      if (line.includes('`')) inHelp = false
      const described =
        line.startsWith('  ') && line.slice(26, 28) === '  ' && /\S/.test(line[28] ?? '')
      return described && !/^ {2}es /.test(line)
        ? `${line.slice(0, 28)}    ${line.slice(28)}`
        : line
    })
    .join('\n')
}

let recorded

/** A file as it was before the rename, from `HEAD`. */
function original(file) {
  return git('show', `HEAD:${file.replace(/^packages\/reeval\//, 'packages/evalsuite/')}`)
}

if (realignOnly) {
  const dir = process.argv[process.argv.indexOf('--realign') + 1]
  if (!dir) {
    console.error('usage: node scripts/rename.mjs --realign <recorded differential dir>')
    process.exit(2)
  }
  await realignCaptures(dir)
  process.exit(0)
}

function rewrite(file, text) {
  let out = text
  for (const p of PATCHES.filter((p) => p.file === file)) {
    if (out.includes(p.from)) out = out.replace(p.from, p.to)
    else if (!out.includes(p.to)) throw new Error(`patch for ${file} no longer applies: ${p.from}`)
  }
  if (file === 'packages/evalsuite/src/cli-spec.ts' && /^ {2}es /m.test(out)) {
    out = shiftHelpColumns(out)
  }
  const kept = []
  const protect = [...PROTECT]
  if (READS_ANALYSIS.test(file)) {
    recorded ??= recordedNames()
    if (recorded) protect.push([recorded])
  }
  for (const [re, only] of protect) {
    if (only && !only.test(file)) continue
    out = out.replace(re, (m) => {
      kept.push(m)
      return `\uE000${kept.length - 1}\uE000`
    })
  }
  // An escaped `\n` or `\t` in a string ends a word, as far as the rules' boundaries go.
  out = out.replace(/\\[nt]/g, (m) => `${m}\uE001`)
  for (const [re, to, only] of RULES) if (!only || only.test(file)) out = out.replace(re, to)
  out = out.replace(/\uE001/g, '')
  return out.replace(/\uE000(\d+)\uE000/g, (_, i) => kept[Number(i)])
}

const dirty = git('status', '--porcelain')
  .split('\n')
  .filter((line) => line && !SELF.includes(line.slice(3)))
if (!check && dirty.length) {
  console.error(`rename: commit or stash your changes first:\n${dirty.join('\n')}`)
  process.exit(1)
}

const files = tracked()
let moved = 0
let changed = 0
const pending = []
for (const file of files) {
  if (SELF.includes(file) || BINARY.test(file) || skipped(file)) continue
  const text = readFileSync(join(root, file), 'utf8')
  if (text.includes(String.fromCharCode(0))) continue
  const out = rewrite(file, text)
  if (out !== text) pending.push([file, out])
}
if (check) {
  const moves = files.filter((f) => movedPath(f) !== f)
  for (const [file] of pending) console.log(`would change ${file}`)
  for (const file of moves) console.log(`would move ${file}`)
  process.exit(pending.length || moves.length ? 1 : 0)
}
for (const [from, to] of [
  ['packages/evalsuite', 'packages/reeval'],
  ['.agents/skills/es', '.agents/skills/reeval'],
]) {
  if (existsSync(join(root, from)) && existsSync(join(root, to))) {
    console.error(`rename: ${to} already exists (untracked leftovers?); remove it, then run again`)
    process.exit(1)
  }
}
for (const [file, out] of pending) {
  writeFileSync(join(root, file), out)
  changed++
}
if (existsSync(join(root, 'packages/evalsuite'))) git('mv', 'packages/evalsuite', 'packages/reeval')
if (existsSync(join(root, '.agents/skills/es')))
  git('mv', '.agents/skills/es', '.agents/skills/reeval')
for (const file of files) {
  const from = file
    .replace(/^packages\/evalsuite\//, 'packages/reeval/')
    .replace(/^\.agents\/skills\/es\//, '.agents/skills/reeval/')
  const to = movedPath(file)
  if (from !== to) {
    git('mv', from, to)
    moved++
  }
}
console.log(`rename: rewrote ${changed} files, moved ${moved} files and 2 directories`)

if (regen) {
  const sh = (cmd, { allowFail = false, cwd = root } = {}) => {
    console.log(`rename: ${cmd}`)
    try {
      execFileSync('bash', ['-c', cmd], { cwd, stdio: 'inherit' })
    } catch (error) {
      if (!allowFail) throw error
    }
  }
  const pkg = join(root, 'packages/reeval')
  sh('pnpm install --no-frozen-lockfile')
  sh('pnpm build')

  // Goldens whose columns the longer names move: regenerate them, then accept only what differs
  // from the rewritten (or, for recorded names, the original) golden in whitespace.
  const goldens = tracked().filter((f) =>
    /^packages\/reeval\/test\/(plan\/.*\/expected\/.*\.txt|fixtures\/cli\/help\.golden\.txt|fixtures\/analysis\/[^/]+\.golden\.json)$/.test(
      f,
    ),
  )
  const before = new Map(goldens.map((f) => [f, readFileSync(join(root, f), 'utf8')]))
  sh(
    'REEVAL_UPDATE_SNAPSHOTS=1 node --test --experimental-strip-types --no-warnings test/plan.test.ts test/cli.test.ts test/analysis.test.ts > /dev/null',
    { allowFail: true, cwd: pkg },
  )
  const problems = []
  for (const file of goldens) {
    const now = readFileSync(join(root, file), 'utf8')
    const bad = unmatched(now.split('\n'), before.get(file).split('\n'), original(file).split('\n'))
    if (bad.length) problems.push(`${file}:\n    ${bad.slice(0, 5).join('\n    ')}`)
  }

  // The differential's captures: record them, then take each field of a recorded run where it
  // matches the rewritten capture (or the original, where it shows recorded names) but for
  // whitespace; every other field stays as the Vitest engine had it, for `compare` to judge.
  const recordedDir = join(mkdtempSync(join(tmpdir(), 'reeval-rename-')), 'differential')
  sh(`node --experimental-strip-types --no-warnings scripts/differential.mjs record ${recordedDir}`)
  sh(`node --experimental-strip-types --no-warnings scripts/rename.mjs --realign ${recordedDir}`)

  // `pnpm run`: bare `pnpm docs` is pnpm's own command, which opens the homepage in a browser.
  sh('pnpm run docs')
  sh('pnpm --dir packages/reeval schema:update')
  sh('pnpm --dir packages/reeval features:matrix --write')
  sh('pnpm format')
  if (problems.length) {
    console.error(`rename: goldens that changed beyond the rename:\n  ${problems.join('\n  ')}`)
    process.exit(1)
  }
}

/**
 * The lines of `actual` that match no line of `renamed` or `original` but for whitespace, each
 * line used once: what a regenerated file changed beyond the rename and realigned columns.
 */
function unmatched(actual, renamed, original) {
  // Slugs, fingerprints, image tags and cache keys hash renamed content; longer names move
  // source columns and where a long line is cut (`…`); the analysis prompt names reeval.
  const loose = (s) =>
    (s ?? '')
      .replace(/\bevals-[a-z0-9-]*-[0-9a-f]{6}\b/g, '<slug>')
      .replace(/(\S)\1{49,}/g, '$1<run>')
      .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{12,}\b/g, '<hex>')
      .replace(/-(?=[0-9a-f]*\d)[0-9a-f]{5,}\b/g, '-<h>')
      .replace(/(\.[cm]?[jt]s):(\d+):\d+/g, '$1:$2:<c>')
      .replace(/size \d+ characters ≈ \d+ tokens/g, 'size <n>')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/,$/, '')
  const same = (a, b) => {
    if (a === b) return true
    const [x, y] = [a.split('…')[0], b.split('…')[0]]
    const shorter = Math.min(x.length, y.length)
    return (
      a.includes('…') &&
      b.includes('…') &&
      shorter >= 8 &&
      x.slice(0, shorter) === y.slice(0, shorter)
    )
  }
  // Two pools, not pairs: sorted output (live lines) sorts the old and new names differently.
  const pools = [renamed, original].map((lines) => lines.map(loose))
  const used = pools.map((p) => new Array(p.length).fill(false))
  const bad = []
  actual.forEach((line, i) => {
    const l = loose(line)
    const hit = pools.some((pool, k) => {
      let at = i < pool.length && !used[k][i] && same(pool[i], l) ? i : -1
      if (at < 0) at = pool.findIndex((p, j) => !used[k][j] && same(p, l))
      if (at >= 0) used[k][at] = true
      return at >= 0
    })
    if (!hit) bad.push(line)
  })
  return actual.length === renamed.length
    ? bad
    : [...bad, `(${actual.length} lines, was ${renamed.length})`]
}

/**
 * Takes each field of the runs recorded into `recordedDir` where it matches the rewritten capture
 * (or the original, where it shows recorded names) but for what `unmatched` allows; every other
 * field stays as the Vitest engine had it, for `compare` to judge.
 */
async function realignCaptures(recordedDir) {
  const { renormalise } = await import(
    pathToFileURL(join(root, 'packages/reeval/test/support/differential.ts')).href
  )
  let taken = 0
  let kept = 0
  const capturesDir = 'packages/reeval/test/differential/vitest'
  for (const file of tracked().filter((f) => f.startsWith(`${capturesDir}/`))) {
    const name = basename(file)
    const actualPath = join(recordedDir, name)
    if (!existsSync(actualPath)) continue
    const parse = (text) =>
      text
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    const renamed = parse(readFileSync(join(root, file), 'utf8'))
    const originals = parse(original(file))
    const actual = new Map()
    for (const c of parse(readFileSync(actualPath, 'utf8'))) {
      actual.set(c.key, [...(actual.get(c.key) ?? []), c])
    }
    const seen = new Map()
    const out = renamed.map((capture, i) => {
      const n = seen.get(capture.key) ?? 0
      seen.set(capture.key, n + 1)
      const run = actual.get(capture.key)?.[n]
      if (!run) return capture
      const next = { ...capture }
      for (const field of Object.keys(capture).filter((f) => f !== 'key')) {
        const lines = (v) =>
          (typeof v === 'string' ? v : JSON.stringify(v ?? null, null, 1)).split('\n')
        const bad = unmatched(
          lines(renormalise(run)[field]),
          lines(renormalise(capture)[field]),
          lines(originals[i] && renormalise(originals[i])[field]),
        )
        if (bad.length) kept++
        else {
          next[field] = run[field]
          taken++
        }
      }
      return next
    })
    writeFileSync(join(root, file), `${out.map((c) => JSON.stringify(c)).join('\n')}\n`)
  }
  console.log(`rename: differential captures: ${taken} fields realigned, ${kept} left for compare`)
}
