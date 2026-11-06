// The plan's `inputs` from its parts: what an environment and sandbox name (src/inputs.ts) and
// what a load reads (src/inputs-load.ts), on generated projects.
import assert from 'node:assert/strict'
import fs, { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { asOwnReads, environmentInputs, inputPath } from '../src/inputs.ts'
import { loadedInputs, trackLoad } from '../src/inputs-load.ts'
import type { EnvironmentLayer, LocalInput } from '../src/types.ts'
import { tempDir } from './helpers.ts'

function tree(files: Record<string, string>): string {
  const root = tempDir('inputs')
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

const layers = (spec: EnvironmentLayer['spec']): EnvironmentLayer[] => [{ name: 'e', spec }]
const SKILL = '---\nname: guide\ndescription: Use when guiding.\n---\nGuide.\n'
const MANIFEST = '{ "name": "tool" }\n'

/** Each input as `kind path`, project-relative, `via` after it. */
const shown = (root: string, inputs: readonly LocalInput[]) =>
  inputs.map(
    (i) => `${i.kind} ${inputPath(root, i.path)}${i.via ? ` via ${inputPath(root, i.via)}` : ''}`,
  )

describe('environmentInputs', () => {
  test('a local npm package: a tarball as itself, a directory as its files less node_modules and .git', () => {
    const root = tree({
      'pkg.tgz': 'tar',
      'pkg/package.json': '{}',
      'pkg/skills/guide/SKILL.md': SKILL,
      'pkg/node_modules/dep/index.js': '',
      'pkg/.git/HEAD': '',
    })
    const found = environmentInputs(
      layers({
        skills: [
          {
            kind: 'skill',
            placement: 'harness',
            source: 'npm',
            spec: join(root, 'pkg.tgz'),
            path: 'skills',
          },
          {
            kind: 'skill',
            placement: 'harness',
            source: 'npm',
            spec: 'some-pkg@1.0.0',
            path: 'skills',
          },
        ],
        plugins: [{ kind: 'plugin', source: 'npm', spec: `file:${join(root, 'pkg')}` }],
      }),
      undefined,
      root,
    )
    assert.deepEqual(shown(root, found.inputs), [
      'npm pkg.tgz',
      'npm pkg/package.json',
      'npm pkg/skills/guide/SKILL.md',
    ])
  })

  test('a local marketplace, local git skill and plugin repositories, and a plugin build context', () => {
    const root = tree({
      'market/.claude-plugin/marketplace.json': '{}',
      'skills-repo/README.md': '',
      'plugin-repo/README.md': '',
      'market.tgz': 'tar',
      'built/.claude-plugin/plugin.json': MANIFEST,
      'built/agents/a.md': 'An agent.',
      'built/src/index.ts': '',
      'built/.dockerignore': 'dist\n',
      'built/dist/out.js': '',
    })
    const found = environmentInputs(
      layers({
        skills: [
          { kind: 'skill', placement: 'harness', source: 'git', repo: join(root, 'skills-repo') },
          { kind: 'skill', placement: 'harness', source: 'git', repo: 'https://example.com/s.git' },
        ],
        plugins: [
          { kind: 'plugin', source: 'git', repo: join(root, 'plugin-repo') },
          {
            kind: 'plugin',
            source: 'marketplace',
            name: 'one',
            marketplace: { source: 'git', repo: join(root, 'market') },
          },
          {
            kind: 'plugin',
            source: 'marketplace',
            name: 'two',
            marketplace: { source: 'npm', spec: join(root, 'market.tgz') },
          },
          {
            kind: 'plugin',
            source: 'local',
            path: join(root, 'built'),
            only: ['agents'],
            build: 'npm run build',
          },
        ],
      }),
      undefined,
      root,
    )
    assert.deepEqual(shown(root, found.inputs), [
      'skill skills-repo',
      'plugin plugin-repo',
      'marketplace market',
      'npm market.tgz',
      'plugin built/.claude-plugin/plugin.json',
      'plugin built/.dockerignore',
      'plugin built/agents/a.md',
      'plugin built/dist/out.js',
      'plugin built/src/index.ts',
      'plugin-build built/.claude-plugin/plugin.json',
      'plugin-build built/.dockerignore',
      'plugin-build built/agents/a.md',
      'plugin-build built/src/index.ts',
    ])
    assert.deepEqual(found.warnings, [])
  })

  test("a plugin without only keeps what readPlugin keeps: the parts it has, so a part's directory without its file is left out", () => {
    const root = tree({
      'p/.claude-plugin/plugin.json': MANIFEST,
      'p/skills/fmt/SKILL.md': SKILL.replace('guide', 'fmt'),
      'p/hooks/start.sh': '',
    })
    const found = environmentInputs(
      layers({ plugins: [{ kind: 'plugin', source: 'local', path: join(root, 'p') }] }),
      undefined,
      root,
    )
    assert.deepEqual(shown(root, found.inputs), [
      'plugin p/.claude-plugin/plugin.json',
      'plugin p/skills/fmt/SKILL.md',
    ])
  })

  test('a SKILL.md or plugin manifest symlinked from outside is read through the link, without a warning', () => {
    const root = tree({
      'shared/SKILL.md': SKILL,
      'shared/plugin.json': MANIFEST,
      'guide/notes.md': '',
      'tool/.claude-plugin/.keep': '',
    })
    symlinkSync('../shared/SKILL.md', join(root, 'guide/SKILL.md'))
    symlinkSync('../../shared/plugin.json', join(root, 'tool/.claude-plugin/plugin.json'))
    const found = environmentInputs(
      layers({
        skills: [
          { kind: 'skill', placement: 'harness', source: 'local', path: join(root, 'guide') },
        ],
        plugins: [{ kind: 'plugin', source: 'local', path: join(root, 'tool') }],
      }),
      undefined,
      root,
    )
    assert.deepEqual(shown(root, found.inputs), [
      'skill shared/SKILL.md via guide/SKILL.md',
      'skill guide/notes.md',
      'plugin tool/.claude-plugin/.keep',
      'plugin shared/plugin.json via tool/.claude-plugin/plugin.json',
    ])
    assert.deepEqual(found.warnings, [])
  })

  test("a symlink to the folder or one of its parents isn't followed, and warns", () => {
    const root = tree({ 'guide/SKILL.md': SKILL, 'big/file.md': '' })
    symlinkSync('..', join(root, 'guide/up'))
    symlinkSync('.', join(root, 'guide/self'))
    const found = environmentInputs(
      layers({
        skills: [
          { kind: 'skill', placement: 'harness', source: 'local', path: join(root, 'guide') },
        ],
      }),
      undefined,
      root,
    )
    assert.deepEqual(shown(root, found.inputs), ['skill guide/SKILL.md'])
    assert.deepEqual(found.warnings, [
      "skill guide: guide/self is a symlink to guide, which holds its folder, so it isn't followed",
      "skill guide: guide/up is a symlink to ., which holds its folder, so it isn't followed",
    ])
  })
})

describe('inputPath', () => {
  test('is project-relative inside the project, including a name that starts with two dots', () => {
    assert.equal(inputPath('/p', '/p/..x'), '..x')
    assert.equal(inputPath('/p', '/p/a/b'), 'a/b')
    assert.equal(inputPath('/p', '/q/a'), '/q/a')
    assert.equal(inputPath('/p', '/p'), '/p')
  })
})

describe('trackLoad', () => {
  test("records the project's reads until stop, less reeval's own and a missing file, then puts fs back", async () => {
    const root = tree({ 'a.json': '{}', 'b.json': '{}', 'c.json': '{}', 'own.json': '{}' })
    const before = [fs.readFileSync, fs.readFile, fs.promises.readFile]
    const tracked = trackLoad(root)
    assert.notEqual(fs.readFileSync, before[0])
    fs.readFileSync(join(root, 'a.json'))
    await new Promise((resolve) => fs.readFile(join(root, 'b.json'), resolve))
    await fs.promises.readFile(new URL(`file://${join(root, 'c.json')}`))
    asOwnReads(() => fs.readFileSync(join(root, 'own.json')))
    assert.throws(() => fs.readFileSync(join(root, 'missing.json')))
    const main = join(root, 'w.eval.ts')
    assert.deepEqual(tracked.stop(main, 'eval'), [
      { path: main, kind: 'eval' },
      { path: join(root, 'a.json'), kind: 'read' },
      { path: join(root, 'b.json'), kind: 'read' },
      { path: join(root, 'c.json'), kind: 'read' },
    ])
    assert.deepEqual([fs.readFileSync, fs.readFile, fs.promises.readFile], before)
    const { readFileSync } = await import('node:fs')
    assert.equal(readFileSync, before[0], 'the ESM view of fs is synced back too')
    fs.readFileSync(join(root, 'own.json'))
    assert.equal(tracked.stop(main, 'eval').length, 4, 'a read after stop is not recorded')
  })
})

describe('loadedInputs', () => {
  test("puts the load's inputs first, less a read that an attempt's own inputs name", () => {
    const loaded: LocalInput[] = [
      { path: '/p/w.eval.ts', kind: 'eval' },
      { path: '/p/skills/guide/SKILL.md', kind: 'read' },
      { path: '/p/data.json', kind: 'read' },
    ]
    const skill: LocalInput = { path: '/p/skills/guide/SKILL.md', kind: 'skill' }
    const merge = loadedInputs(loaded, [[skill], [], undefined])
    assert.deepEqual(merge([skill]), [loaded[0], loaded[2], skill])
    assert.deepEqual(merge(undefined), [loaded[0], loaded[2]])
  })
})
