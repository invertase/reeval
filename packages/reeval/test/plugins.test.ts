// Plugins on the host: reading a plugin directory, what `only` keeps, the refusals each harness
// gives, and what resolving an environment with plugins places and records.
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { ANTIGRAVITY_HOOK_EVENTS } from '@reeval/harness-antigravity'
import {
  buildSteps,
  builtPlugins,
  droppedPaths,
  fetchesAtStart,
  PluginProblem,
  pluginBuildId,
  pluginFiles,
  readPlugin,
} from '../src/environment/plugins.ts'
import { resolveEnvironment } from '../src/environment/resolve.ts'
import { applied, defineEnvironment } from '../src/environment.ts'
import {
  AGENTS,
  agentMcp,
  claudePluginFiles,
  cursorHookMatcher,
  LAYOUTS,
  refusedPlugins,
  writePluginFiles,
} from '../src/harness/agents.ts'
import { unpackPlugins } from '../src/harness/unpack.ts'
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
    otherTypes: [],
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
  assert.deepEqual(p.hooks, { events: [], commands: [], otherTypes: [] })
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

test('a real harness without plugin parts refuses every plugin', () => {
  const p = readPlugin(review(), 'x')
  for (const [kind, agent] of Object.entries(AGENTS)) {
    if (agent.pluginParts.length) continue
    assert.equal(
      refusedPlugins({ kind } as never, [p], { skills: [], mcp: [] }),
      `${agent.name} can't load plugins yet: leave the review plugin out of this cell`,
    )
  }
  assert.equal(
    refusedPlugins({ kind: 'goose' } as never, [], { skills: [], mcp: [] }, [
      "plugin.git('github:acme/x')",
    ]),
    "Goose can't load plugins yet: leave plugin.git('github:acme/x') out of this cell",
  )
  assert.equal(refusedPlugins({ kind: 'goose' } as never, [], { skills: [], mcp: [] }), undefined)
  assert.equal(refusedPlugins({ kind: 'fake' }, [p], { skills: [], mcp: [] }), undefined)
})

test('Claude Code and Grok Build load every part but rules, and refuse a plugin server’s host secret', () => {
  const whole = readPlugin(review(), 'x')
  const kept = readPlugin(review(), 'x', ['skills', 'agents', 'commands', 'hooks'])
  const withMcp = readPlugin(review(), 'x', ['skills', 'mcp'])
  for (const [kind, name] of [
    ['claude-code', 'Claude Code'],
    ['grok-build', 'Grok Build'],
  ] as const) {
    assert.equal(
      refusedPlugins({ kind } as never, [whole], { skills: [], mcp: [] }),
      `${name} can't load the review plugin's rules (rules/): use only: ['skills', 'agents', 'commands', 'hooks', 'mcp'], or leave the plugin out of this cell`,
    )
    assert.equal(refusedPlugins({ kind } as never, [kept], { skills: [], mcp: [] }), undefined)
    assert.equal(
      refusedPlugins({ kind } as never, [withMcp], { skills: [], mcp: [] }),
      `${name} loads the review plugin's MCP server "docs" itself, so reeval can't give it DOCS_TOKEN from the host: use only: ['skills'] and declare the server in mcp, where reeval fills it in`,
    )
  }
  assert.equal(
    refusedPlugins({ kind: 'fake', layout: 'claude-code' } as never, [whole], {
      skills: [],
      mcp: [],
    }),
    "The fake agent with Claude Code's layout can't load the review plugin's rules (rules/): use only: ['skills', 'agents', 'commands', 'hooks', 'mcp'], or leave the plugin out of this cell",
  )
})

test('Cursor and Antigravity load every part, and refuse hook events they don’t run', () => {
  const whole = readPlugin(review(), 'x')
  const notified = readPlugin(
    write(review(), {
      'hooks/hooks.json': JSON.stringify({
        hooks: { Notification: [{ hooks: [{ type: 'command', command: 'notify' }] }] },
      }),
    }),
    'x',
  )
  assert.equal(
    refusedPlugins({ kind: 'cursor' } as never, [whole], { skills: [], mcp: [] }),
    undefined,
  )
  assert.equal(
    refusedPlugins({ kind: 'cursor' } as never, [notified], { skills: [], mcp: [] }),
    "Cursor can't run the review plugin's Notification hooks (hooks/hooks.json): it runs SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse, SubagentStop, PreCompact, Stop hooks; use only: ['skills', 'agents', 'commands', 'mcp', 'rules'], or leave the plugin out of this cell",
  )
  const kept = readPlugin(review(), 'x', ['skills', 'agents', 'commands', 'hooks', 'rules'])
  assert.equal(
    refusedPlugins({ kind: 'antigravity' } as never, [kept], { skills: [], mcp: [] }),
    undefined,
  )
  assert.equal(
    refusedPlugins({ kind: 'antigravity' } as never, [notified], { skills: [], mcp: [] }),
    "Antigravity can't run the review plugin's Notification hooks (hooks/hooks.json): it runs SessionStart, PreToolUse, PostToolUse, Stop hooks; use only: ['skills', 'agents', 'commands', 'mcp', 'rules'], or leave the plugin out of this cell",
  )
  // agy installs the plugin's servers itself, from its .mcp.json, as Claude Code does.
  assert.equal(
    refusedPlugins({ kind: 'antigravity' } as never, [whole], { skills: [], mcp: [] }),
    `Antigravity loads the review plugin's MCP server "docs" itself, so reeval can't give it DOCS_TOKEN from the host: use only: ['skills', 'agents', 'commands', 'hooks', 'rules'] and declare the server in mcp, where reeval fills it in`,
  )
  // Cursor takes them in its own MCP config, where reeval fills the secret in.
  assert.equal(LAYOUTS.cursor.pluginPlacement, 'flat')
  assert.deepEqual(LAYOUTS.antigravity.pluginHookEvents, Object.keys(ANTIGRAVITY_HOOK_EVENTS))
})

test('Antigravity refuses a plugin with a manifest agy reads in place of the Claude Code one', () => {
  const none = { skills: [], mcp: [] }
  for (const manifest of [
    'plugin.json',
    '.antigravity-plugin/plugin.json',
    '.gemini-plugin/plugin.json',
    'gemini-extension.json',
  ]) {
    const p = readPlugin(write(review(), { [manifest]: '{"name":"native"}' }), 'x', ['skills'])
    assert.deepEqual(p.manifests, [manifest])
    assert.equal(
      refusedPlugins({ kind: 'antigravity' } as never, [p], none),
      `Antigravity reads the review plugin's ${manifest} in place of its .claude-plugin/plugin.json, so reeval can't hold it to the parts it places: remove ${manifest} from the plugin, or leave the plugin out of this cell`,
    )
    assert.equal(refusedPlugins({ kind: 'cursor' } as never, [p], none), undefined)
  }
  // agy ignores Cursor's manifest, and Cursor's plugins are unpacked by reeval, never loaded.
  const cursorManifest = readPlugin(
    write(review(), { '.cursor-plugin/plugin.json': '{"name":"native"}' }),
    'x',
    ['skills'],
  )
  assert.equal(refusedPlugins({ kind: 'antigravity' } as never, [cursorManifest], none), undefined)
  assert.equal(refusedPlugins({ kind: 'cursor' } as never, [cursorManifest], none), undefined)
})

test('on Cursor, two plugins’ subagents or commands unpacked to one file clash', () => {
  const other = (parts: Record<string, string>) =>
    readPlugin(write(tmp(), { '.claude-plugin/plugin.json': '{"name":"audit"}', ...parts }), 'y')
  const p = readPlugin(review(), 'x', ['agents', 'commands'])
  assert.equal(
    refusedPlugins({ kind: 'cursor' } as never, [p, other({ 'agents/reviewer.md': 'Audit.\n' })], {
      skills: [],
      mcp: [],
    }),
    `the audit plugin's subagent "reviewer" and the review plugin's would both be placed at .cursor/agents/reviewer.md: rename one, or narrow one with only`,
  )
  assert.equal(
    refusedPlugins({ kind: 'cursor' } as never, [p, other({ 'commands/review.md': 'Audit.\n' })], {
      skills: [],
      mcp: [],
    }),
    `the audit plugin's command "review" and the review plugin's would both be placed at .cursor/commands/review.md: rename one, or narrow one with only`,
  )
  // Antigravity keeps each plugin in its own directory, so the same names don't meet.
  assert.equal(
    refusedPlugins(
      { kind: 'antigravity' } as never,
      [p, other({ 'agents/reviewer.md': 'Audit.\n' })],
      { skills: [], mcp: [] },
    ),
    undefined,
  )
})

test('on Cursor, two rules unpacked to one file clash, and a hook that isn’t a command is refused', () => {
  const none = { skills: [], mcp: [] }
  const p = readPlugin(write(review(), { 'rules/style.mdc': 'Typed.\n' }), 'x', ['rules'])
  assert.equal(
    refusedPlugins({ kind: 'cursor' } as never, [p], none),
    `the review plugin's rule "style.mdc" and the review plugin's rule "style.md" would both be placed at .cursor/rules/review-style.mdc: rename one, or narrow one with only`,
  )
  const named = (name: string, rule: string) =>
    readPlugin(
      write(tmp(), {
        '.claude-plugin/plugin.json': JSON.stringify({ name }),
        [`rules/${rule}.md`]: 'Rule.\n',
      }),
      name,
    )
  assert.equal(
    refusedPlugins({ kind: 'cursor' } as never, [named('a-b', 'c'), named('a', 'b-c')], none),
    `the a plugin's rule "b-c.md" and the a-b plugin's rule "c.md" would both be placed at .cursor/rules/a-b-c.mdc: rename one, or narrow one with only`,
  )
  assert.equal(
    refusedPlugins({ kind: 'antigravity' } as never, [named('a-b', 'c'), named('a', 'b-c')], none),
    undefined,
  )
  const prompted = readPlugin(
    write(review(), {
      'hooks/hooks.json': JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt: 'Is the task done?' }] }] },
      }),
    }),
    'x',
    ['commands', 'hooks'],
  )
  assert.deepEqual(prompted.hooks.otherTypes, ['prompt'])
  for (const [kind, name] of [
    ['cursor', 'Cursor'],
    ['antigravity', 'Antigravity'],
  ] as const) {
    assert.equal(
      refusedPlugins({ kind } as never, [prompted], none),
      `${name} can't run the review plugin's prompt hooks (hooks/hooks.json): it runs only command hooks; use only: ['commands'], or leave the plugin out of this cell`,
    )
  }
  assert.equal(refusedPlugins({ kind: 'claude-code' } as never, [prompted], none), undefined)
})

test('unpackPlugins writes a flat agent’s rules, subagents, commands and hooks', () => {
  const dir = write(review(), {
    'rules/style.md': 'Write small functions.\n',
    'rules/pinned.mdc': '---\nglobs: "*.ts"\n---\n\nTyped.\n',
    'hooks/hooks.json': JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: `${ref('CLAUDE_PLUGIN_ROOT')}/s` }] }],
        PreToolUse: [
          { matcher: 'Bash|Edit', hooks: [{ type: 'command', command: 'check', timeout: 5 }] },
          { matcher: 'Glob', hooks: [{ type: 'command', command: 'never' }] },
          { matcher: 'mcp__docs__search', hooks: [{ type: 'command', command: 'mcp' }] },
        ],
      },
    }),
  })
  const p = readPlugin(dir, 'x')
  const placed = { name: p.name, dir: '/home/reeval/.reeval/plugins/review', parts: p.kept }
  const own = JSON.stringify({ hooks: { stop: [{ type: 'command', command: 'own' }] } })
  const unpack = LAYOUTS.cursor.pluginUnpack
  assert.ok(unpack)
  const files = Object.fromEntries(
    unpackPlugins([{ ...placed, files: pluginFiles(p) }], unpack, own).map((f) => [
      f.path,
      f.content,
    ]),
  )
  assert.deepEqual(Object.keys(files).sort(), [
    '.cursor/agents/reviewer.md',
    '.cursor/commands/review.md',
    '.cursor/hooks.json',
    '.cursor/rules/review-pinned.mdc',
    '.cursor/rules/review-style.mdc',
  ])
  assert.equal(
    files['.cursor/rules/review-style.mdc'],
    '---\nalwaysApply: true\n---\n\nWrite small functions.\n',
  )
  assert.equal(files['.cursor/rules/review-pinned.mdc'], '---\nglobs: "*.ts"\n---\n\nTyped.\n')
  assert.equal(files['.cursor/agents/reviewer.md'], 'Review the diff.\n')
  assert.deepEqual(JSON.parse(files['.cursor/hooks.json'] ?? ''), {
    version: 1,
    hooks: {
      stop: [{ type: 'command', command: 'own' }],
      sessionStart: [{ type: 'command', command: '/home/reeval/.reeval/plugins/review/s' }],
      preToolUse: [
        { type: 'command', command: 'check', timeout: 5, matcher: 'Shell|Write' },
        { type: 'command', command: 'mcp', matcher: 'MCP:search' },
      ],
    },
  })
  // Only the parts the plugin keeps.
  const narrowed = readPlugin(dir, 'x', ['skills', 'rules'])
  assert.deepEqual(
    unpackPlugins([{ ...placed, parts: narrowed.kept, files: pluginFiles(narrowed) }], unpack).map(
      (f) => f.path,
    ),
    ['.cursor/rules/review-pinned.mdc', '.cursor/rules/review-style.mdc'],
  )
  assert.throws(
    () => unpackPlugins([{ ...placed, files: pluginFiles(p) }], unpack, '{'),
    /The workspace's \.cursor\/hooks\.json isn't valid JSON/,
  )
})

test('cursorHookMatcher maps Claude Code tool names on the tool events only', () => {
  assert.equal(cursorHookMatcher('PreToolUse', 'Bash'), 'Shell')
  assert.equal(cursorHookMatcher('PostToolUse', 'Edit|Write'), 'Write')
  assert.equal(cursorHookMatcher('PreToolUse', 'Glob'), null)
  assert.equal(cursorHookMatcher('PreToolUse', 'mcp__docs__search_all'), 'MCP:search_all')
  assert.equal(cursorHookMatcher('PreToolUse', '*'), undefined)
  assert.equal(cursorHookMatcher('PreToolUse', undefined), undefined)
  assert.equal(cursorHookMatcher('SessionStart', 'startup'), undefined)
})

test('a part the harness can’t load is refused, naming what it can', () => {
  const p = readPlugin(review(), 'x')
  loading('cursor', ['skills', 'mcp'], () => {
    assert.equal(
      refusedPlugins({ kind: 'cursor' } as never, [p], { skills: [], mcp: [] }),
      "Cursor can't load the review plugin's agents (agents/) and commands (commands/) and hooks (hooks/hooks.json) and rules (rules/): use only: ['skills', 'mcp'], or leave the plugin out of this cell",
    )
    const narrowed = readPlugin(review(), 'x', ['skills', 'mcp'])
    assert.equal(
      refusedPlugins({ kind: 'cursor' } as never, [narrowed], { skills: [], mcp: [] }),
      undefined,
    )
    const hooksOnly = readPlugin(review(), 'x', ['hooks'])
    assert.equal(
      refusedPlugins({ kind: 'cursor' } as never, [hooksOnly], { skills: [], mcp: [] }),
      "Cursor can't load the review plugin's hooks (hooks/hooks.json): leave the plugin out of this cell",
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
  const keyless = readPlugin(
    write(tmp(), {
      '.claude-plugin/plugin.json': '{"name":"review"}',
      'skills/lint/SKILL.md': skillMd('review-lint'),
      '.mcp.json': JSON.stringify({ mcpServers: { docs: { command: 'node' } } }),
    }),
    'x',
  )
  loading('claude-code', ['skills', 'mcp'], () => {
    assert.equal(
      refusedPlugins({ kind: 'claude-code' } as never, [keyless], {
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
      harness: { kind: 'goose' } as never,
    }),
    /environment review \(e\): Goose can't load plugins yet: leave the review plugin out of this cell/,
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

test('Claude Code enables the placed plugins from a directory marketplace, and namespaced agents start their servers', () => {
  const placed = [
    {
      name: 'review',
      dir: '/home/reeval/.reeval/plugins/review',
      parts: [],
      servers: ['review:docs'],
    },
    { name: 'tidy', dir: '/home/reeval/.reeval/plugins/tidy', parts: [], servers: [] },
  ]
  const files = Object.fromEntries(
    claudePluginFiles(placed).map((f) => [f.path, JSON.parse(f.content)]),
  )
  assert.deepEqual(files, {
    '~/.reeval/plugins/.claude-plugin/marketplace.json': {
      name: 'reeval',
      owner: { name: 'reeval' },
      plugins: [
        { name: 'review', source: './review' },
        { name: 'tidy', source: './tidy' },
      ],
    },
    '~/.claude/settings.json': {
      extraKnownMarketplaces: {
        reeval: { source: { source: 'directory', path: '/home/reeval/.reeval/plugins' } },
      },
      enabledPlugins: { 'review@reeval': true, 'tidy@reeval': true },
    },
  })
  assert.deepEqual(claudePluginFiles([]), [])
  const mcp = { own: { command: 'own' }, 'review:docs': { command: 'docs' } } as never
  assert.deepEqual(Object.keys(agentMcp(LAYOUTS['claude-code'], mcp, placed)), ['own'])
  assert.deepEqual(Object.keys(agentMcp(LAYOUTS['grok-build'], mcp, placed)), ['own'])
  assert.deepEqual(Object.keys(agentMcp(LAYOUTS.cursor, mcp, placed)), ['own', 'review:docs'])
})

test('Claude Code’s plugin settings merge into a ~/.claude/settings.json files already wrote', async () => {
  const placed = [
    { name: 'review', dir: '/home/reeval/.reeval/plugins/review', parts: [], servers: [] },
  ]
  const files = new Map<string, string>()
  const box = {
    readFile: async (path: string) => files.get(path) ?? null,
    writeFile: async (path: string, content: string | Uint8Array) => {
      files.set(path, String(content))
    },
  } as never
  files.set(
    '~/.claude/settings.json',
    JSON.stringify({ env: { A: '1' }, enabledPlugins: { 'other@elsewhere': false } }),
  )
  const written = await writePluginFiles(box, LAYOUTS['claude-code'], placed)
  assert.deepEqual(written, [
    '~/.reeval/plugins/.claude-plugin/marketplace.json',
    '~/.claude/settings.json',
  ])
  const settings = JSON.parse(files.get('~/.claude/settings.json') ?? '')
  assert.deepEqual(settings.env, { A: '1' })
  assert.deepEqual(settings.enabledPlugins, { 'other@elsewhere': false, 'review@reeval': true })
  assert.equal(settings.extraKnownMarketplaces.reeval.source.source, 'directory')
  // Again, as a retried start writes them: the same file.
  const once = files.get('~/.claude/settings.json')
  await writePluginFiles(box, LAYOUTS['claude-code'], placed)
  assert.equal(files.get('~/.claude/settings.json'), once)
  files.set('~/.claude/settings.json', '[]')
  await assert.rejects(
    writePluginFiles(box, LAYOUTS['claude-code'], placed),
    /~\/\.claude\/settings\.json isn't a JSON object, so reeval can't enable the session's plugins in it/,
  )
  assert.deepEqual(await writePluginFiles(box, LAYOUTS.cursor, placed), [])
})

test('Grok Build refuses a plugin MCP server named like another, since it keeps one; Claude Code namespaces them', () => {
  const plugin = (name: string) =>
    readPlugin(
      write(tmp(), {
        '.claude-plugin/plugin.json': JSON.stringify({ name }),
        '.mcp.json': JSON.stringify({ mcpServers: { docs: { command: 'node' } } }),
      }),
      'x',
    )
  const [review, tidy] = [plugin('review'), plugin('tidy')]
  assert.equal(
    refusedPlugins({ kind: 'grok-build' } as never, [review], { skills: [], mcp: ['docs'] }),
    `Grok Build names the review plugin's MCP server "docs" by its own name, as it does mcp.docs, and keeps only one: rename one, or leave mcp out of the plugin with only`,
  )
  assert.equal(
    refusedPlugins({ kind: 'grok-build' } as never, [review, tidy], { skills: [], mcp: [] }),
    `Grok Build names the tidy plugin's MCP server "docs" by its own name, as it does the review plugin's MCP server "docs", and keeps only one: rename one, or leave mcp out of the plugin with only`,
  )
  assert.equal(
    refusedPlugins({ kind: 'fake', layout: 'grok-build' } as never, [review], {
      skills: [],
      mcp: ['docs'],
    }),
    `The fake agent with Grok Build's layout names the review plugin's MCP server "docs" by its own name, as it does mcp.docs, and keeps only one: rename one, or leave mcp out of the plugin with only`,
  )
  assert.equal(
    refusedPlugins({ kind: 'grok-build' } as never, [review], { skills: [], mcp: ['other'] }),
    undefined,
  )
  assert.equal(
    refusedPlugins({ kind: 'claude-code' } as never, [review, tidy], { skills: [], mcp: ['docs'] }),
    undefined,
  )
})
