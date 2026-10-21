// Plugins on the host: reading a plugin directory, what `only` keeps, the refusals each harness
// gives, reading a marketplace entry, and what resolving an environment with plugins places and records.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import {
  buildSteps,
  builtPlugins,
  droppedPaths,
  fetchesAtStart,
  PluginProblem,
  pluginBuildId,
  pluginFiles,
  readMarketplace,
  readPlugin,
} from '../src/environment/plugins.ts'
import { resolveEnvironment } from '../src/environment/resolve.ts'
import { applied, defineEnvironment } from '../src/environment.ts'
import { AGENTS, refusedPlugins } from '../src/harness/agents.ts'
import { InfraError } from '../src/sandbox/types.ts'
import type { PluginBuild, PluginPart } from '../src/types.ts'

const write = (root: string, files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

/** How a plugin's .mcp.json and hooks write a variable: `${NAME}`. */
const ref = (name: string) => `\${${name}}`

const tmp = () => mkdtempSync(join(tmpdir(), 'reeval-plugins-'))

const skillMd = (name: string) => `---\nname: ${name}\ndescription: ${name}.\n---\n\nBody.\n`

/** A plugin with one of every part. */
const review = (root = tmp(), name = 'review') => {
  write(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name, version: '1.0.0' }),
    'skills/lint/SKILL.md': skillMd('review-lint'),
    'agents/reviewer.md': 'Review the diff.\n',
    'commands/review.md': 'Review the tree.\n',
    'hooks/hooks.json': JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: `${ref('CLAUDE_PLUGIN_ROOT')}/start.sh` }] },
        ],
      },
    }),
    'start.sh': '#!/bin/sh\necho started\n',
    '.mcp.json': JSON.stringify({
      mcpServers: {
        docs: {
          command: 'node',
          args: [`${ref('CLAUDE_PLUGIN_ROOT')}/server.mjs`],
          env: { DOCS_TOKEN: ref('DOCS_TOKEN'), MODE: 'ci' },
        },
        search: {
          type: 'http',
          url: 'https://search.example.com/mcp',
          headers: { Authorization: `Bearer ${ref('SEARCH_KEY')}` },
        },
      },
    }),
    'server.mjs': 'process.stdin.resume()\n',
    'rules/style.md': 'Prefer small functions.\n',
  })
  chmodSync(join(root, 'start.sh'), 0o755)
  return root
}

test('a plugin is read in Claude Code’s layout: every part, and its MCP servers as reeval’s', () => {
  const p = readPlugin(review(), "plugin.local('review')")
  assert.equal(p.name, 'review')
  assert.deepEqual(p.has, ['skills', 'agents', 'commands', 'hooks', 'mcp', 'rules'])
  assert.deepEqual(p.kept, p.has)
  assert.deepEqual(p.skills, [{ dir: 'lint', name: 'review-lint' }])
  assert.deepEqual(p.agents, ['reviewer'])
  assert.deepEqual(p.commands, ['review'])
  assert.deepEqual(p.hooks, {
    events: ['SessionStart'],
    commands: [`${ref('CLAUDE_PLUGIN_ROOT')}/start.sh`],
  })
  assert.deepEqual(p.rules, ['style.md'])
  assert.deepEqual(p.mcp.docs, {
    kind: 'mcp',
    transport: 'stdio',
    command: 'node',
    args: [`${ref('CLAUDE_PLUGIN_ROOT')}/server.mjs`],
    env: { DOCS_TOKEN: { kind: 'secret', from: 'DOCS_TOKEN' }, MODE: 'ci' },
  })
  assert.deepEqual(p.mcp.search, {
    kind: 'mcp',
    transport: 'http',
    url: 'https://search.example.com/mcp',
    headers: {
      Authorization: { kind: 'secret-template', template: `Bearer ${ref('SEARCH_KEY')}` },
    },
  })
})

test('the manifest’s mcpServers, inline or a path, stand in for .mcp.json', () => {
  const inline = write(tmp(), {
    '.claude-plugin/plugin.json': JSON.stringify({
      name: 'inline',
      mcpServers: { docs: { command: 'node', args: ['s.mjs'] } },
    }),
  })
  assert.deepEqual(Object.keys(readPlugin(inline, 'x').mcp), ['docs'])
  const pointed = write(tmp(), {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'pointed', mcpServers: './servers.json' }),
    'servers.json': JSON.stringify({ mcpServers: { api: { url: 'https://api.example.com/mcp' } } }),
  })
  assert.equal(readPlugin(pointed, 'x').mcp.api?.transport, 'http')
})

test('only keeps the parts it names, and the files it drops stay out of the sandbox', () => {
  const p = readPlugin(review(), 'x', ['skills'])
  assert.deepEqual(p.kept, ['skills'])
  assert.deepEqual(p.mcp, {})
  assert.deepEqual(p.hooks, { events: [], commands: [] })
  const files = pluginFiles(p)
  const paths = files.map((f) => f.path)
  assert.ok(paths.includes('skills/lint/SKILL.md'))
  for (const gone of [
    '.mcp.json',
    'hooks/hooks.json',
    'agents/reviewer.md',
    'commands/review.md',
    'rules/style.md',
  ]) {
    assert.ok(!paths.includes(gone), `${gone} is left out`)
  }
  if (process.platform !== 'win32') {
    assert.equal(files.find((f) => f.path === 'start.sh')?.executable, true, 'modes are kept')
  }
  const inline = write(tmp(), {
    '.claude-plugin/plugin.json': JSON.stringify({
      name: 'inline',
      mcpServers: { docs: { command: 'node' } },
    }),
    'skills/a/SKILL.md': skillMd('a'),
  })
  const manifest = pluginFiles(readPlugin(inline, 'x', ['skills'])).find(
    (f) => f.path === '.claude-plugin/plugin.json',
  )
  assert.deepEqual(JSON.parse(Buffer.from(manifest?.content ?? '').toString()), { name: 'inline' })
})

test('a plugin reeval can’t place as written is a PluginProblem that says why', () => {
  const problem = (dir: string, only?: PluginPart[]) => {
    try {
      readPlugin(dir, "plugin.local('p')", only)
    } catch (error) {
      assert.ok(error instanceof PluginProblem)
      return error.message
    }
    assert.fail('no problem')
  }
  assert.equal(problem(tmp()), "plugin.local('p') has no .claude-plugin/plugin.json")
  assert.equal(problem(join(tmp(), 'missing')), "plugin.local('p') isn't a directory")
  assert.match(
    problem(write(tmp(), { '.claude-plugin/plugin.json': '{"name":"Not Kebab"}' })),
    /needs a name in kebab-case, e\.g\. "name": "review" \(got "Not Kebab"\)/,
  )
  assert.equal(
    problem(write(tmp(), { '.claude-plugin/plugin.json': '{"name":"empty"}' })),
    'the empty plugin has nothing to place: no skills/*/SKILL.md, agents/*.md, commands/*.md, hooks/hooks.json, .mcp.json or rules/',
  )
  assert.match(
    problem(
      write(tmp(), {
        '.claude-plugin/plugin.json': '{"name":"moved","skills":"./elsewhere"}',
        'skills/a/SKILL.md': skillMd('a'),
      }),
    ),
    /the moved plugin's manifest sets "skills", which reeval doesn't read/,
  )
  const skillsOnly = write(tmp(), {
    '.claude-plugin/plugin.json': '{"name":"review"}',
    'skills/a/SKILL.md': skillMd('a'),
  })
  assert.equal(
    problem(skillsOnly, ['hooks']),
    "the review plugin has no hooks, so only: ['hooks'] matches nothing (it has skills)",
  )
  assert.equal(
    problem(skillsOnly, ['skills', 'mcp']),
    "the review plugin has no mcp, which only: ['skills', 'mcp'] names (it has skills)",
  )
  assert.match(
    problem(
      write(tmp(), {
        '.claude-plugin/plugin.json': '{"name":"vars"}',
        '.mcp.json': JSON.stringify({
          docs: { command: 'node', env: { URL: `https://${ref('HOST')}/x` } },
        }),
      }),
    ),
    /MCP server "docs": env\.URL in \.mcp\.json puts a variable inside a longer value/,
  )
})

test('npx, bunx, uvx and pipx run fetch at start: refused under a policy without the registry, a note under allow-all', () => {
  const fetcher = readPlugin(
    write(tmp(), {
      '.claude-plugin/plugin.json': JSON.stringify({
        name: 'fetcher',
        mcpServers: { search: { command: 'npx', args: ['-y', '@acme/search-mcp'] } },
      }),
      'hooks/hooks.json': JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'uvx ruff check' }] }] },
      }),
    }),
    'x',
  )
  assert.deepEqual(fetchesAtStart([fetcher], null), {
    notes: [
      `the fetcher plugin's MCP server "search" runs npx, which fetches from registry.npmjs.org at start; add a build that installs it to keep it off the network`,
      `the fetcher plugin's hook "uvx ruff check" runs uvx, which fetches from pypi.org at start; add a build that installs it to keep it off the network`,
    ],
  })
  assert.equal(
    fetchesAtStart([fetcher], []).refusal,
    `the fetcher plugin's MCP server "search" runs npx, which fetches from registry.npmjs.org at start: add a build that installs it, or allow the host in egress`,
  )
  assert.equal(
    fetchesAtStart([fetcher], ['registry.npmjs.org']).refusal,
    `the fetcher plugin's hook "uvx ruff check" runs uvx, which fetches from pypi.org at start: add a build that installs it, or allow the host in egress`,
  )
  assert.deepEqual(fetchesAtStart([fetcher], ['registry.npmjs.org', 'pypi.org']), { notes: [] })
})

test('a build is commands and where they run, the same for each way of writing it', () => {
  const env = defineEnvironment('e', ({ plugin }) => ({
    plugins: [
      plugin.npm('a@1', { build: 'make' }),
      plugin.npm('b@1', { build: ['npm ci', 'npm run build'] }),
      plugin.git('github:o/r', { path: 'plugins/x', build: { run: 'pnpm i', cwd: './' } }),
    ],
  }))
  const builds = builtPlugins(applied(env).layers)
  assert.deepEqual(
    builds.map((p) => buildSteps(p.build as PluginBuild)),
    [
      { run: ['make'], cwd: null },
      { run: ['npm ci', 'npm run build'], cwd: null },
      { run: ['pnpm i'], cwd: '.' },
    ],
  )
  // Preflight and the attempt name a build by its declaration, so another build is another layer.
  const ids = builds.map(pluginBuildId)
  assert.equal(new Set(ids).size, 3)
  assert.deepEqual(builtPlugins(applied(env).layers).map(pluginBuildId), ids)
})

test('a built plugin keeps only the parts only names: the rest of its directory is removed', () => {
  assert.deepEqual(droppedPaths(['skills', 'mcp']), ['agents', 'commands', 'hooks', 'rules'])
  assert.deepEqual(droppedPaths(['agents', 'hooks', 'rules']), ['skills', 'commands', '.mcp.json'])
})

/** Runs `fn` with the agent's catalog entry loading `parts`, as its placement PR will. */
const loading = <T>(kind: keyof typeof AGENTS, parts: PluginPart[], fn: () => T): T => {
  const agent = AGENTS[kind]
  const before = agent.pluginParts
  agent.pluginParts = parts
  try {
    return fn()
  } finally {
    agent.pluginParts = before
  }
}

test('every real harness refuses every plugin until its placement lands', () => {
  const p = readPlugin(review(), 'x')
  for (const [kind, agent] of Object.entries(AGENTS)) {
    assert.equal(
      refusedPlugins({ kind } as never, [p], { skills: [], mcp: [] }),
      `${agent.name} can't load plugins yet: leave the review plugin out of this cell`,
    )
  }
  assert.equal(
    refusedPlugins({ kind: 'cursor' } as never, [], { skills: [], mcp: [] }, [
      "plugin.git('github:acme/x')",
    ]),
    "Cursor can't load plugins yet: leave plugin.git('github:acme/x') out of this cell",
  )
  assert.equal(refusedPlugins({ kind: 'cursor' } as never, [], { skills: [], mcp: [] }), undefined)
  assert.equal(refusedPlugins({ kind: 'fake' }, [p], { skills: [], mcp: [] }), undefined)
})

test('a part the harness can’t load is refused, naming what it can', () => {
  const p = readPlugin(review(), 'x')
  loading('codex', ['skills', 'mcp'], () => {
    assert.equal(
      refusedPlugins({ kind: 'codex' } as never, [p], { skills: [], mcp: [] }),
      "Codex can't load the review plugin's agents (agents/) and commands (commands/) and hooks (hooks/hooks.json) and rules (rules/): use only: ['skills', 'mcp'], or leave the plugin out of this cell",
    )
    const narrowed = readPlugin(review(), 'x', ['skills', 'mcp'])
    assert.equal(
      refusedPlugins({ kind: 'codex' } as never, [narrowed], { skills: [], mcp: [] }),
      undefined,
    )
    const hooksOnly = readPlugin(review(), 'x', ['hooks'])
    assert.equal(
      refusedPlugins({ kind: 'codex' } as never, [hooksOnly], { skills: [], mcp: [] }),
      "Codex can't load the review plugin's hooks (hooks/hooks.json): leave the plugin out of this cell",
    )
  })
})

test('a plugin MCP server the harness refuses gets the harness’s own sentence, named <plugin>:<server>', () => {
  const sse = readPlugin(
    write(tmp(), {
      '.claude-plugin/plugin.json': '{"name":"review"}',
      '.mcp.json': JSON.stringify({
        events: { type: 'sse', url: 'https://events.example.com/sse' },
      }),
    }),
    'x',
  )
  loading('codex', ['mcp'], () => {
    assert.match(
      refusedPlugins({ kind: 'codex' } as never, [sse], { skills: [], mcp: [] }) ?? '',
      /Codex has no SSE MCP transport, so it can't use the review:events server/,
    )
  })
})

test('on a flat harness, a plugin skill or MCP server named like the environment’s own clashes', () => {
  const p = readPlugin(review(), 'x', ['skills', 'mcp'])
  loading('cursor', ['skills', 'mcp'], () => {
    assert.equal(
      refusedPlugins({ kind: 'cursor' } as never, [p], { skills: [], mcp: ['docs'] }),
      `the review plugin's MCP server "docs" clashes with mcp.docs`,
    )
    assert.equal(
      refusedPlugins({ kind: 'cursor' } as never, [p], {
        skills: [{ name: 'review-lint', call: "skill.local('skills')" }],
        mcp: [],
      }),
      `the review plugin's skill "review-lint" and skill.local('skills')'s "review-lint" would both be placed at ~/.agents/skills/review-lint: rename one, or narrow it with only or exclude`,
    )
  })
  loading('claude-code', ['skills', 'mcp'], () => {
    assert.equal(
      refusedPlugins({ kind: 'claude-code' } as never, [p], {
        skills: [{ name: 'review-lint', call: "skill.local('skills')" }],
        mcp: ['docs'],
      }),
      undefined,
      'Claude Code namespaces plugin items',
    )
  })
})

test('resolving places each plugin, records it, and lists its skills and MCP servers', async (t) => {
  process.env.DOCS_TOKEN = 'docs-token'
  process.env.SEARCH_KEY = 'search-key'
  t.after(() => {
    delete process.env.DOCS_TOKEN
    delete process.env.SEARCH_KEY
  })
  const root = tmp()
  const dir = review(join(root, 'plugins/review'))
  write(root, { 'skills/own/SKILL.md': skillMd('own') })
  const env = defineEnvironment('review', ({ plugin, skill }) => ({
    skills: [skill.local(join(root, 'skills'))],
    plugins: [plugin.local(dir)],
  }))
  const r = await resolveEnvironment(applied(env), {}, root, 'e', 'AGENTS.md')
  assert.deepEqual(
    r.plugins.map((p) => [p.name, p.parts, p.servers]),
    [
      [
        'review',
        ['skills', 'agents', 'commands', 'hooks', 'mcp', 'rules'],
        ['review:docs', 'review:search'],
      ],
    ],
  )
  const [record] = r.record.plugins ?? []
  assert.deepEqual(
    { ...record, sha256: typeof record?.sha256 },
    {
      name: 'review',
      source: 'local:plugins/review',
      marketplace: null,
      commit: null,
      sha256: 'string',
      build: null,
      parts: {
        skills: ['review-lint'],
        agents: ['reviewer'],
        commands: ['review'],
        hooks: ['SessionStart'],
        mcp: ['docs', 'search'],
        rules: true,
      },
    },
  )
  assert.deepEqual(
    r.record.skills.map((s) => [s.name, s.plugin]),
    [
      ['own', undefined],
      ['review-lint', 'review'],
    ],
  )
  assert.deepEqual(r.record.mcp, ['review:docs', 'review:search'])
  assert.deepEqual(
    r.skills.map((s) => s.name),
    ['own', 'review-lint'],
    'the fake agent takes plugin items flat, so its skills are harness skills',
  )
  const without = await resolveEnvironment(
    applied(
      defineEnvironment('plain', ({ skill }) => ({ skills: [skill.local(join(root, 'skills'))] })),
    ),
    {},
    root,
    'e',
    'AGENTS.md',
  )
  assert.notEqual(without.record.digest, r.record.digest, 'plugins are in the digest')
  assert.equal(without.record.plugins, undefined)
})

test('a child’s plugin replaces a same-named parent plugin, and overrides names it', async () => {
  const root = tmp()
  const parentDir = review(join(root, 'a'))
  const childDir = write(join(root, 'b'), {
    '.claude-plugin/plugin.json': '{"name":"review"}',
    'skills/tidy/SKILL.md': skillMd('tidy'),
  })
  const parent = defineEnvironment('parent', ({ plugin }) => ({
    plugins: [plugin.local(parentDir)],
  }))
  const child = parent.extend('child', ({ plugin }) => ({ plugins: [plugin.local(childDir)] }))
  const r = await resolveEnvironment(applied(child), {}, root, 'e', 'AGENTS.md')
  assert.deepEqual(r.record.overrides, ['plugins.review'])
  assert.deepEqual(
    r.record.plugins?.map((p) => [p.name, p.source, p.parts.skills]),
    [['review', 'local:b', ['tidy']]],
  )
  assert.deepEqual(r.record.mcp, [])
})

test('resolving for a real harness refuses the plugin, and an http server egress doesn’t allow', async () => {
  const root = tmp()
  const dir = review(join(root, 'review'))
  const env = applied(
    defineEnvironment('review', ({ plugin }) => ({ plugins: [plugin.local(dir)] })),
  )
  await assert.rejects(
    resolveEnvironment(env, {}, root, 'e', 'AGENTS.md', 'allow-all', undefined, {
      harness: { kind: 'cursor' } as never,
    }),
    /environment review \(e\): Cursor can't load plugins yet: leave the review plugin out of this cell/,
  )
  await assert.rejects(
    resolveEnvironment(env, {}, root, 'e', 'AGENTS.md', 'allow-all', undefined, { allowed: [] }),
    /the review plugin's MCP server "search" is at search\.example\.com, which egress doesn't allow/,
  )
  process.env.DOCS_TOKEN = 'docs-token'
  process.env.SEARCH_KEY = 'search-key'
  try {
    const r = await resolveEnvironment(env, {}, root, 'e', 'AGENTS.md', 'deny-all', undefined, {
      allowed: ['*.example.com'],
    })
    assert.deepEqual(r.record.mcp, ['review:docs', 'review:search'], 'a wildcard allows the host')
  } finally {
    delete process.env.DOCS_TOKEN
    delete process.env.SEARCH_KEY
  }
})

test('one environment listing two plugins of one name is refused, not one silently dropped', async () => {
  const root = tmp()
  const a = review(join(root, 'a'))
  const b = write(join(root, 'b'), {
    '.claude-plugin/plugin.json': '{"name":"review"}',
    'skills/tidy/SKILL.md': skillMd('tidy'),
  })
  const env = defineEnvironment('both', ({ plugin }) => ({
    plugins: [plugin.local(a), plugin.local(b)],
  }))
  await assert.rejects(resolveEnvironment(applied(env), {}, root, 'e', 'AGENTS.md'), {
    message: `environment both (e): environment both lists two plugins named "review", plugin.local('a') and plugin.local('b'): rename one, or leave one out`,
  })
})

test('a variable in a plugin server’s command or args, other than CLAUDE_PLUGIN_ROOT, is refused', () => {
  const dir = write(tmp(), {
    '.claude-plugin/plugin.json': '{"name":"vars"}',
    '.mcp.json': JSON.stringify({
      docs: { command: 'node', args: [`${ref('CLAUDE_PLUGIN_ROOT')}/s.mjs`, ref('HOME')] },
    }),
  })
  assert.throws(() => readPlugin(dir, 'x'), {
    name: 'PluginProblem',
    message: `the vars plugin's MCP server "docs": "${ref('HOME')}" in .mcp.json names a variable; reeval fills in only ${ref('CLAUDE_PLUGIN_ROOT')} in a command and its args, so pass a host variable through env, e.g. "env": { "TOKEN": "${ref('TOKEN')}" }`,
  })
})

test('a plugin server whose <plugin>:<server> key mcp already has is refused on every placement', () => {
  const p = readPlugin(review(), 'x', ['mcp'])
  for (const kind of ['fake', 'claude-code'] as const) {
    const run = () => refusedPlugins({ kind } as never, [p], { skills: [], mcp: ['review:docs'] })
    assert.equal(
      kind === 'fake' ? run() : loading(kind, ['mcp'], run),
      `the review plugin's MCP server "docs" would join mcp as review:docs, which mcp already names: rename mcp["review:docs"]`,
      kind,
    )
  }
})

const marketplace = (root: string, json: unknown) =>
  write(root, { '.claude-plugin/marketplace.json': JSON.stringify(json) })

test('a marketplace entry’s source is a ./path, a git repository or an npm package', () => {
  const dir = marketplace(tmp(), {
    name: 'acme-tools',
    owner: { name: 'Acme' },
    metadata: { pluginRoot: './plugins' },
    plugins: [
      { name: 'lint', source: './plugins/lint' },
      { name: 'format', source: 'format' },
      { name: 'gh', source: { source: 'github', repo: 'acme/gh-plugin', ref: 'v2' } },
      {
        name: 'pinned',
        source: {
          source: 'url',
          url: 'https://git.example.com/p.git',
          ref: 'main',
          sha: '0123456789abcdef0123456789abcdef01234567',
        },
      },
      {
        name: 'sub',
        source: { source: 'git-subdir', url: 'acme/mono', path: 'tools/sub/', ref: 'v1' },
      },
      { name: 'pkg', source: { source: 'npm', package: '@acme/pkg', version: '2.1.0' } },
      { name: 'latest', source: { source: 'npm', package: '@acme/latest' } },
    ],
  })
  const entry = (name: string) => readMarketplace(dir, 'call', 'github:acme/tools', name)
  assert.deepEqual(entry('lint'), {
    marketplace: 'acme-tools',
    entry: { source: 'path', path: 'plugins/lint' },
  })
  assert.deepEqual(entry('format').entry, { source: 'path', path: 'plugins/format' })
  assert.deepEqual(entry('gh').entry, {
    source: 'git',
    url: 'https://github.com/acme/gh-plugin.git',
    repo: 'github:acme/gh-plugin',
    ref: 'v2',
  })
  assert.deepEqual(entry('pinned').entry, {
    source: 'git',
    url: 'https://git.example.com/p.git',
    repo: 'https://git.example.com/p.git',
    ref: '0123456789abcdef0123456789abcdef01234567',
  })
  assert.deepEqual(entry('sub').entry, {
    source: 'git',
    url: 'https://github.com/acme/mono.git',
    repo: 'github:acme/mono',
    ref: 'v1',
    path: 'tools/sub',
  })
  assert.deepEqual(entry('pkg').entry, { source: 'npm', spec: '@acme/pkg@2.1.0' })
  assert.deepEqual(entry('latest').entry, { source: 'npm', spec: '@acme/latest' })
})

test('a marketplace reeval can’t read, or an entry it doesn’t list or can’t fetch, is a PluginProblem', () => {
  const problem = (dir: string, name: string) => {
    try {
      readMarketplace(
        dir,
        "plugin.marketplace('lint@github:acme/tools')",
        'github:acme/tools',
        name,
      )
    } catch (error) {
      assert.ok(error instanceof PluginProblem)
      return error.message
    }
    assert.fail('no problem')
  }
  assert.equal(
    problem(tmp(), 'lint'),
    "plugin.marketplace('lint@github:acme/tools'): github:acme/tools has no .claude-plugin/marketplace.json, so it isn't a Claude Code marketplace; name a plugin's own repository or package with plugin.git or plugin.npm",
  )
  assert.match(
    problem(marketplace(tmp(), { plugins: [] }), 'lint'),
    /github:acme\/tools's \.claude-plugin\/marketplace\.json needs a name and a plugins list/,
  )
  const listed = marketplace(tmp(), {
    name: 'acme-tools',
    plugins: [
      { name: 'lints', source: './lints' },
      { name: 'format', source: './format' },
      { name: 'escape', source: './../outside' },
      { name: 'bare', source: 'bare' },
      { name: 'moved', source: './moved', commands: ['./cmd'] },
      { name: 'zip', source: { source: 'url', url: '' } },
      { name: 'private', source: { source: 'npm', package: 'p', registry: 'https://r.example' } },
    ],
  })
  assert.equal(
    problem(listed, 'lint'),
    'plugin.marketplace(\'lint@github:acme/tools\'): the acme-tools marketplace (github:acme/tools) has no plugin "lint" (did you mean "lints"?); it lists lints, format, escape, bare, moved, zip, private',
  )
  assert.match(
    problem(listed, 'escape'),
    /the acme-tools marketplace's entry "escape" has source "\.\/\.\.\/outside", which reeval doesn't fetch: it takes a \.\/path in the marketplace, or a github, url, git-subdir or npm source/,
  )
  assert.match(
    problem(listed, 'bare'),
    /entry "bare" has source "bare", which reeval doesn't fetch/,
  )
  assert.match(
    problem(listed, 'moved'),
    /entry "moved" sets "commands", which reeval doesn't read: keep each part in the plugin's own directory/,
  )
  assert.match(problem(listed, 'zip'), /entry "zip" has source \{"source":"url","url":""\}/)
  assert.match(problem(listed, 'private'), /names its own npm registry/)
})

test('a bare entry source resolves under pluginRoot as Claude Code normalises it, and nowhere else', () => {
  const entries = [
    { name: 'bare', source: 'format' },
    { name: 'nested', source: 'tools/format' },
    { name: 'root', source: '.' },
  ]
  const at = (pluginRoot: unknown, name: string) => {
    const dir = marketplace(tmp(), { name: 'm', metadata: { pluginRoot }, plugins: entries })
    try {
      return readMarketplace(dir, 'call', 'label', name).entry
    } catch (error) {
      assert.ok(error instanceof PluginProblem)
      return 'refused'
    }
  }
  assert.deepEqual(at('plugins', 'bare'), { source: 'path', path: 'plugins/format' })
  assert.deepEqual(at('./plugins/', 'bare'), { source: 'path', path: 'plugins/format' })
  assert.deepEqual(at('.', 'bare'), { source: 'path', path: 'format' })
  assert.equal(at('plugins', 'nested'), 'refused')
  assert.equal(at('../outside', 'bare'), 'refused')
  assert.equal(at('/etc', 'bare'), 'refused')
  assert.equal(at(undefined, 'bare'), 'refused')
  assert.deepEqual(at(undefined, 'root'), { source: 'path', path: '' })
})

test('a marketplace entry can’t reach the host: refs and urls that git would take as options, local paths, tokens, symlinks and npm specs that aren’t registry packages', () => {
  const token = 'ghp_0123456789abcdefghij'
  const root = tmp()
  const dir = marketplace(join(root, 'market'), {
    name: 'acme-tools',
    plugins: [
      { name: 'option', source: { source: 'url', url: '.', ref: '--upload-pack=touch pwned' } },
      { name: 'dash-url', source: { source: 'url', url: '--upload-pack=touch pwned' } },
      { name: 'short-sha', source: { source: 'github', repo: 'acme/p', sha: 'abc1234' } },
      { name: 'local', source: { source: 'url', url: '/home/me/private' } },
      { name: 'ext', source: { source: 'git-subdir', url: 'ext::sh -c id', path: 'p' } },
      { name: 'token', source: { source: 'url', url: `https://x:${token}@github.com/a/b.git` } },
      { name: 'token-hg', source: { source: 'hg', url: `https://x:${token}@hg.example/p` } },
      { name: 'npm-git', source: { source: 'npm', package: 'git+ssh://git@github.com/a/b.git' } },
      { name: 'npm-path', source: { source: 'npm', package: '../../secret' } },
      { name: 'npm-alias', source: { source: 'npm', package: 'p', version: 'file:../x' } },
      { name: 'linked', source: './linked' },
      { name: 'scp', source: { source: 'url', url: 'git@github.com:acme/p.git', ref: 'v1' } },
    ],
  })
  write(join(root, 'outside'), { '.claude-plugin/plugin.json': '{"name":"linked"}' })
  symlinkSync(join(root, 'outside'), join(dir, 'linked'), 'junction')
  const problem = (name: string) => {
    try {
      readMarketplace(dir, 'call', 'label', name)
    } catch (error) {
      assert.ok(error instanceof PluginProblem)
      return error.message
    }
    assert.fail(`${name}: no problem`)
  }
  assert.equal(
    problem('option'),
    'the acme-tools marketplace\'s entry "option" has ref "--upload-pack=touch pwned", which isn\'t a branch or tag',
  )
  assert.match(problem('dash-url'), /which reeval doesn't fetch/)
  assert.match(problem('short-sha'), /has sha "abc1234", which isn't a full 40-character/)
  assert.match(problem('local'), /which reeval doesn't fetch/)
  assert.match(problem('ext'), /which reeval doesn't fetch/)
  assert.match(problem('token'), /has a password or token in its url/)
  for (const name of ['token', 'token-hg']) assert.ok(!problem(name).includes(token), name)
  assert.match(problem('npm-git'), /isn't a registry package name/)
  assert.match(problem('npm-path'), /isn't a registry package name/)
  assert.match(problem('npm-alias'), /has npm version "file:\.\.\/x"/)
  assert.match(problem('linked'), /leaves the marketplace through a symlink/)
  assert.deepEqual(readMarketplace(dir, 'call', 'label', 'scp').entry, {
    source: 'git',
    url: 'git@github.com:acme/p.git',
    repo: 'git@github.com:acme/p.git',
    ref: 'v1',
  })
})

/**
 * A git repository at `dir`, committed, with `v1` tagged on the first commit. Its files check out
 * byte for byte, as Windows' `core.autocrlf` would otherwise turn `\n` into `\r\n` in a clone.
 */
const gitRepo = (dir: string, files: Record<string, string>) => {
  const g = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      cwd: dir,
      encoding: 'utf8',
    }).trim()
  write(dir, { '.gitattributes': '* -text\n', ...files })
  g('init', '-q', '-b', 'main')
  g('add', '-A')
  g('commit', '-q', '-m', 'v1')
  g('tag', 'v1')
  return { url: pathToFileURL(dir).href, head: g('rev-parse', 'HEAD'), g }
}

test('resolving a marketplace entry places that plugin alone and records the marketplace and its commit', async () => {
  const root = tmp()
  const other = gitRepo(join(root, 'other'), {
    'plugin/.claude-plugin/plugin.json': '{"name":"remote"}',
    'plugin/commands/far.md': 'Far.\n',
  })
  const repo = gitRepo(join(root, 'market'), {
    '.claude-plugin/marketplace.json': JSON.stringify({
      name: 'acme-tools',
      plugins: [
        { name: 'review', source: './plugins/review' },
        { name: 'lint', source: './plugins/lint' },
        {
          name: 'remote',
          source: { source: 'git-subdir', url: other.url, path: 'plugin', sha: other.head },
        },
      ],
    }),
    'plugins/review/.claude-plugin/plugin.json': '{"name":"review"}',
    'plugins/review/agents/reviewer.md': 'Review.\n',
    'plugins/lint/.claude-plugin/plugin.json': '{"name":"lint"}',
    'plugins/lint/commands/lint.md': 'Lint.\n',
  })
  write(join(root, 'market'), { 'plugins/review/agents/reviewer.md': 'Review v2.\n' })
  repo.g('commit', '-q', '-am', 'v2')
  const env = defineEnvironment('market', ({ plugin }) => ({
    plugins: [
      plugin.marketplace(`review@${repo.url}`, { ref: 'v1' }),
      plugin.marketplace(`remote@${repo.url}`),
    ],
  }))
  const r = await resolveEnvironment(applied(env), {}, root, 'e', 'AGENTS.md')
  const v1 = repo.g('rev-parse', 'v1')
  const head = repo.g('rev-parse', 'HEAD')
  assert.deepEqual(
    r.record.plugins?.map((p) => [p.name, p.source, p.commit, p.marketplace]),
    [
      [
        'review',
        `${repo.url}#v1:plugins/review`,
        v1,
        { name: 'acme-tools', source: `${repo.url}#v1`, commit: v1 },
      ],
      [
        'remote',
        `${other.url}#${other.head}:plugin`,
        other.head,
        { name: 'acme-tools', source: repo.url, commit: head },
      ],
    ],
  )
  const [review, remote] = r.plugins
  assert.deepEqual(
    review?.files.map((f) => [f.path, Buffer.from(f.content).toString()]),
    [
      ['.claude-plugin/plugin.json', '{"name":"review"}'],
      ['agents/reviewer.md', 'Review.\n'],
    ],
    'the entry at v1, and none of the lint entry',
  )
  assert.deepEqual(
    remote?.files.map((f) => f.path),
    ['.claude-plugin/plugin.json', 'commands/far.md'],
  )
  await assert.rejects(
    resolveEnvironment(
      applied(
        defineEnvironment('typo', ({ plugin }) => ({
          plugins: [plugin.marketplace(`reviews@${repo.url}`)],
        })),
      ),
      {},
      root,
      'e',
      'AGENTS.md',
    ),
    (error: Error) => {
      assert.ok(error instanceof InfraError)
      assert.equal(
        error.message,
        `environment typo (e): plugin.marketplace('reviews@${repo.url}'): the acme-tools marketplace (${repo.url}) has no plugin "reviews" (did you mean "review"?); it lists review, lint, remote`,
      )
      return true
    },
  )
  await assert.rejects(
    resolveEnvironment(
      applied(
        defineEnvironment('bare', ({ plugin }) => ({
          plugins: [plugin.marketplace(`far@${other.url}`)],
        })),
      ),
      {},
      root,
      'e',
      'AGENTS.md',
    ),
    (error: Error) =>
      error instanceof InfraError &&
      error.message.endsWith(
        `${other.url} has no .claude-plugin/marketplace.json, so it isn't a Claude Code marketplace; name a plugin's own repository or package with plugin.git or plugin.npm`,
      ),
  )
})

test('a git ref that reads as an option is never passed to git as one', async () => {
  const root = tmp()
  const repo = gitRepo(join(root, 'repo'), { '.claude-plugin/plugin.json': '{"name":"p"}' })
  const marker = join(root, 'pwned')
  const env = defineEnvironment('opt', {
    plugins: [
      {
        kind: 'plugin',
        source: 'git',
        repo: repo.url,
        ref: `--upload-pack=touch ${marker}; git-upload-pack`,
      },
    ],
  })
  await assert.rejects(resolveEnvironment(applied(env), {}, root, 'e', 'AGENTS.md'), InfraError)
  assert.ok(!existsSync(marker), 'git ran the ref as --upload-pack')
})
