// The rename from ES (`@invertase/foobar`, CLI `es`) to reeval, as a repeatable codemod. Run it
// on a clean checkout of `main`, from the repository root:
//
//   node scripts/rename.mjs            move and rewrite files, then regenerate what's generated
//   node scripts/rename.mjs --no-regen move and rewrite only
//   node scripts/rename.mjs --check    exit 1 if a rewrite would still change something
//
// Then `bash scripts/rename-verify.sh`. What it leaves alone, on purpose:
// - recorded history (the corpus, analysis fixtures, the old schema snapshot, captured replays and
//   the Claude Code bridge capture), which an older ES wrote and which must keep loading;
// - persisted identifiers that readers match on: `kind: 'es-run'`, `'es-analysis'`, the anomaly
//   kind `'es-bug'`, the action kind `'es'`, the record field `es` (its version), and the
//   `evalsuite:` salt of `hostHash`;
// - the sandbox's `es` user, `/home/es` and `/es/workspace`, which the captured real-agent
//   streams in test/replay and each harness's test fixtures contain.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const args = new Set(process.argv.slice(2))
const check = args.has('--check')
const regen = !args.has('--no-regen') && !check

const SELF = ['scripts/rename.mjs', 'scripts/rename-verify.sh']
const SKIP = [
  /\/test\/fixtures\/(records|analysis|schema|claude-code-bridge)\//,
  /\/test\/replay\//,
  /^pnpm-lock\.yaml$/,
  /^CHANGELOG\.md$/,
  /^\.release-please-manifest\.json$/,
]
const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|tgz|gz|zip|wasm)$/i
const COMMANDS =
  'init|doctor|run|clean|record|history|show|compare|checkout|query|analyze|mcp|studio|report|image|help'

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
  /evalsuite:\$\{hostname\(\)\}/g,
  /\bes-(?:run|analysis|bug)\b/g,
  /\bes-ts-/g,
  /`es`(?=,? `judge_model`)/g,
  /`es`(?= user\b| \(uid| \(SANDBOX_USER)/g,
  /the `es` user/g,
  /\bas `es`/g,
]

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
  [/(\^|\/)es \\S\+ —/g, '$1reeval \\S+ —'],
  [/\bes%20/g, 'reeval%20'],
  [/\['es', '/g, "['reeval', '"],
  [/(['\s])j\.es(?=['",\s])/g, '$1j.eval', /\/test\/(differential\/vitest\/)?options\.test\.ts/],
  [/"es": \{/g, '"reeval": {', /^docs\/recipes\/agent-mcp\.mdx$/],
  [/`es`/g, '`reeval`'],
  [/(^|[`'"/^[\uE001])es: /gm, '$1reeval: '],
  [/\bes:egress\b/g, 'reeval:egress'],
  [/\bes:\/\//g, 'reeval://'],
  [/\["es", "mcp"/g, '["reeval", "mcp"'],
  [/\bes-(?=[a-z0-9])/g, 'reeval-'],
  [/\bes_(?=[a-z])/g, 'reeval_'],
  [/\b(A|a)n ES\b(?! modules?\b)/g, '$1 reeval'],
  [/\bES\b(?! modules?\b)(?!\d)/g, 'reeval'],
]

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
    file: 'packages/evalsuite/src/view/analysis.ts',
    from: "ANALYSIS_PROMPT_VERSION = 'analysis-v1'",
    to: "ANALYSIS_PROMPT_VERSION = 'analysis-v2'",
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
  for (const re of PROTECT) {
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
  const sh = (cmd) => {
    console.log(`rename: ${cmd}`)
    execFileSync('bash', ['-c', cmd], { cwd: root, stdio: 'inherit' })
  }
  sh('pnpm install --no-frozen-lockfile')
  sh('pnpm build')
  // `pnpm run`: bare `pnpm docs` is pnpm's own command, which opens the homepage in a browser.
  sh('pnpm run docs')
  sh('pnpm --dir packages/reeval schema:update')
  sh('pnpm --dir packages/reeval features:matrix --write')
  sh('pnpm format')
}
