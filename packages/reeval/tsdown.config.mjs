// Bundles reeval with tsdown. The workspace's @reeval/* packages are private and
// inlined from their TypeScript sources, so the published package imports only its own
// `dependencies`. What ships next to the code: each of those packages' other `files` (such as
// sandbox-docker's `docker/` build context), at the package root beside `dist/`, where their
// `../<dir>` from a module names the same place, and the prebuilt studio app (`dist/studio-app`).
// Those lookups go through src/root.ts, reeval's one resource locator: the build rewrites each
// `new URL('<path>', import.meta.url)` in an inlined package to root.ts's `ownFileURL`, and fails
// on any other import.meta.url, so a compiled es (scripts/bun-compile.mjs) finds them too. THIRD_PARTY_NOTICES.md, at the root, lists the third-party code all of
// that inlines (scripts/third-party.mjs).
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, posix, relative, sep } from 'node:path'
import { defineConfig } from 'tsdown'
import {
  bundledLicenses,
  markedFiles,
  packageDir,
  packageLicense,
  renderNotices,
} from '../../scripts/third-party.mjs'

const here = import.meta.dirname
const require = createRequire(import.meta.url)
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))

/** `@reeval/<name>[/sub]` → its source file, from each workspace package's `exports`. */
const sources = new Map()
/** Each workspace package's shipped directories besides `dist/`, by name, → where they are. */
const assets = new Map()
/** Each inlined package's directory → the paths in it that ship with reeval, at the same place. */
const shipped = new Map()
for (const name of Object.keys(pkg.devDependencies).filter((d) => d.startsWith('@reeval/'))) {
  const dir = dirname(realpathSync(require.resolve(`${name}/package.json`)))
  const { exports, files } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  for (const [sub, target] of Object.entries(exports)) {
    if (typeof target === 'string') continue // ./package.json
    const file = join(dir, target.default.replace(/^\.\/dist\/(.*)\.js$/, 'src/$1.ts'))
    if (!existsSync(file)) throw new Error(`${name}: no source for ${sub} (${file})`)
    sources.set(join(name, sub), file)
  }
  for (const asset of files.filter((f) => f !== 'dist')) {
    if (assets.has(asset)) throw new Error(`${name} and another package both ship ${asset}/`)
    if (!pkg.files.includes(asset)) throw new Error(`${name} ships ${asset}/: add it to files`)
    assets.set(asset, join(dir, asset))
  }
  shipped.set(
    dir,
    files.filter((f) => f !== 'dist'),
  )
}

/**
 * Upstream adapters inlined from their published `dist/`, not imported, so the published package
 * runs the build pnpm patched (`patchedDependencies`). Each reads its bridge files from
 * `./bridge/` next to its code, which lands in a chunk at `dist/`'s top level.
 */
const patched = ['@ai-sdk/harness-claude-code']
const BRIDGE_FILES = ['index.mjs', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']
/** What the adapters' own build inlined into `bridge/index.mjs`, resolved from the adapter. */
const BRIDGE_BUNDLES = ['@ai-sdk/harness']
for (const name of patched) {
  if (!pkg.devDependencies[name] || pkg.dependencies[name])
    throw new Error(`${name} is inlined: list it in devDependencies only`)
  shipped.set(dirname(realpathSync(require.resolve(`${name}/package.json`))), ['dist/bridge'])
}

const root = join(here, 'src/root.ts')
const OWN_FILE_URL = /new URL\(\s*(['"`])([^'"`$]+)\1\s*,\s*import\.meta\.url\s*\)/g

/** How many times `ast` reads `import.meta.url`. */
function importMetaUrls(ast) {
  let count = 0
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (!node || typeof node !== 'object') return
    if (
      node.type === 'MemberExpression' &&
      node.object?.type === 'MetaProperty' &&
      node.object.meta?.name === 'import' &&
      node.property?.name === 'url'
    )
      count++
    for (const key in node) if (key !== 'parent') walk(node[key])
  }
  walk(ast)
  return count
}

/**
 * An inlined package's `new URL('<path>', import.meta.url)` → `ownFileURL('<path in package>')`,
 * on the same line, so the source map still holds. The path must be one the package ships.
 */
function ownFiles(code, id) {
  const dir = [...shipped.keys()].find((d) => id.startsWith(d + sep))
  if (!dir || !code.includes('import.meta.url')) return null
  const out = code.replace(OWN_FILE_URL, (match, _quote, path) => {
    const file = relative(dir, join(dirname(id), path))
      .split(sep)
      .join(posix.sep)
    if (!shipped.get(dir).some((f) => file === f || file.startsWith(`${f}/`)))
      throw new Error(`${id} finds ${file} from import.meta.url, but reeval doesn't ship it`)
    const lines = '\n'.repeat(match.split('\n').length - 1)
    return `__esOwnFileURL(${lines}${JSON.stringify(path.endsWith('/') ? `${file}/` : file)})`
  })
  return `${out}\nimport { ownFileURL as __esOwnFileURL } from ${JSON.stringify(root)}\n`
}

const dist = join(here, 'dist')
const studioWeb = join(here, '../studio-web')
const studioApp = join(studioWeb, 'dist')
/** studio-web's build writes the third-party packages it inlined here. */
const studioLicenses = join(studioApp, 'third-party.json')
let bundled = []

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    harness: 'src/harness.ts',
    sandbox: 'src/sandbox.ts',
    judge: 'src/judge.ts',
    'view/index': 'src/view/index.ts',
    testing: 'src/testing.ts',
    // `reeval`, and `reeval __worker`, which the engine starts for each eval file (src/engine/pool.ts).
    cli: 'src/bin.ts',
  },
  platform: 'node',
  fixedExtension: false,
  dts: true,
  sourcemap: true,
  // c8 reads the sources from the checkout; the tarball doesn't need a second copy.
  outputOptions: { sourcemapExcludeSources: true },
  deps: {
    alwaysBundle: [/^@reeval\//, ...patched],
    onlyBundle: false,
    onlyImport: Object.keys(pkg.dependencies),
  },
  plugins: [
    {
      name: 'reeval-sources',
      resolveId: {
        order: 'pre',
        handler: (id) => sources.get(id),
      },
      transform: {
        order: 'pre',
        handler: (code, id) => {
          const out = ownFiles(code, id)
          return out === null ? null : { code: out, map: null }
        },
      },
      // Only src/root.ts reads import.meta.url, to find the package one level up; a string that
      // mentions it (a script written into the sandbox) doesn't count.
      renderChunk(code, chunk) {
        if (/\.d\.[cm]?ts$/.test(chunk.fileName)) return null
        const uses = importMetaUrls(this.parse(code))
        const isRoot = chunk.moduleIds.includes(root)
        if (uses > (isRoot ? 1 : 0) || (isRoot && chunk.fileName.includes('/')))
          throw new Error(
            `${chunk.facadeModuleId ?? chunk.moduleIds.at(-1)} (in dist/${chunk.name}) uses import.meta.url: find reeval's files from src/root.ts`,
          )
        return null
      },
    },
    bundledLicenses('dist', (packages) => {
      bundled = packages
    }),
  ],
  hooks: {
    'build:done': ({ chunks }) => {
      for (const chunk of chunks) {
        const file = relative(dist, join(chunk.outDir, chunk.fileName))
        const code = chunk.type === 'chunk' ? chunk.code : String(chunk.source)
        if (/(?:\bfrom|\bimport)\s*\(?\s*['"]@reeval\//.test(code))
          throw new Error(`dist/${file} imports an @reeval/* package`)
      }
      const thirdParty = [...bundled]
      for (const name of patched) {
        const adapter = dirname(realpathSync(require.resolve(`${name}/package.json`)))
        const bridge = join(adapter, 'dist/bridge')
        const { version } = JSON.parse(readFileSync(join(adapter, 'package.json'), 'utf8'))
        const patch = `patches/${name.replace('/', '__')}@${version}.patch`
        const changed = [
          ...readFileSync(join(here, '../..', patch), 'utf8').matchAll(
            /^diff --git a\/dist\/bridge\/(\S+)/gm,
          ),
        ].map((m) => m[1])
        for (const file of BRIDGE_FILES) {
          const code = readFileSync(join(bridge, file), 'utf8')
          // Apache-2.0 §4(b): a modified file says so.
          const notice = `// Modified by Invertase with ${patch}; see THIRD_PARTY_NOTICES.md.\n`
          mkdirSync(join(dist, 'bridge'), { recursive: true })
          const marked = changed.includes(file) && /\.m?js$/.test(file)
          writeFileSync(join(dist, 'bridge', file), marked ? notice + code : code)
        }
        thirdParty.push({
          ...packageLicense(adapter, 'dist/bridge'),
          modified: `${changed.map((f) => `dist/bridge/${f}`).join(', ')}, with ${patch}`,
        })
        for (const inlined of BRIDGE_BUNDLES)
          thirdParty.push(packageLicense(packageDir(inlined, adapter), 'dist/bridge'))
      }
      for (const [asset, from] of assets) {
        rmSync(join(here, asset), { recursive: true, force: true })
        cpSync(from, join(here, asset), { recursive: true })
      }
      if (existsSync(join(studioApp, 'index.html'))) {
        cpSync(studioApp, join(dist, 'studio-app'), {
          recursive: true,
          filter: (file) => file !== studioLicenses,
        })
        thirdParty.push(...JSON.parse(readFileSync(studioLicenses, 'utf8')))
      } else
        console.warn(
          "studio-web isn't built; reeval studio will have no app. Run pnpm build from the repo root.",
        )
      // The published package's README is the repo-root README, copied so the
      // tarball has the same file. It is handwritten; `pnpm docs` does not write it.
      cpSync(join(here, '../..', 'README.md'), join(here, 'README.md'))
      const shadcn = markedFiles(join(studioWeb, 'src'), 'shadcn/ui', join(here, '../..'))
      writeFileSync(
        join(here, 'THIRD_PARTY_NOTICES.md'),
        renderNotices(pkg.name, thirdParty, [
          {
            title: 'shadcn/ui',
            license: 'MIT',
            licenseText: readFileSync(join(studioWeb, 'src/components/ui/LICENSE'), 'utf8'),
            source: 'https://github.com/shadcn-ui/ui',
            files: shadcn,
          },
        ]),
      )
    },
  },
})
