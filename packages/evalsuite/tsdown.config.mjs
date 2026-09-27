// Bundles @invertase/foobar with tsdown. The workspace's @evalsuite/* packages are private and
// inlined from their TypeScript sources, so the published package imports only its own
// `dependencies`. What ships next to the code: each of those packages' other `files` (such as
// sandbox-docker's `docker/` build context), at the package root beside `dist/`, where their
// `../<dir>` from a module finds it in a chunk too, and the prebuilt studio app
// (`dist/studio-app`).
import { cpSync, existsSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { defineConfig } from 'tsdown'

const here = import.meta.dirname
const require = createRequire(import.meta.url)
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))

/** `@evalsuite/<name>[/sub]` → its source file, from each workspace package's `exports`. */
const sources = new Map()
/** Each workspace package's shipped directories besides `dist/`, by name, → where they are. */
const assets = new Map()
for (const name of Object.keys(pkg.devDependencies).filter((d) => d.startsWith('@evalsuite/'))) {
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
}

/**
 * Upstream adapters inlined from their published `dist/`, not imported, so the published package
 * runs the build pnpm patched (`patchedDependencies`). Each reads its bridge files from
 * `./bridge/` next to its code, which lands in a chunk at `dist/`'s top level.
 */
const patched = ['@ai-sdk/harness-claude-code']
const BRIDGE_FILES = ['index.mjs', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']
for (const name of patched) {
  if (!pkg.devDependencies[name] || pkg.dependencies[name])
    throw new Error(`${name} is inlined: list it in devDependencies only`)
}

const dist = join(here, 'dist')
const studioApp = join(here, '../studio-web/dist')

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    harness: 'src/harness.ts',
    sandbox: 'src/sandbox.ts',
    judge: 'src/judge.ts',
    'view/index': 'src/view/index.ts',
    cli: 'src/cli.ts',
    // Vitest loads these two by path (src/engine/node.ts).
    setup: 'src/setup.ts',
    'worker-signals': 'src/engine/worker-signals.ts',
  },
  platform: 'node',
  fixedExtension: false,
  dts: true,
  sourcemap: true,
  // c8 reads the sources from the checkout; the tarball doesn't need a second copy.
  outputOptions: { sourcemapExcludeSources: true },
  deps: {
    alwaysBundle: [/^@evalsuite\//, ...patched],
    onlyBundle: false,
    onlyImport: Object.keys(pkg.dependencies),
  },
  plugins: [
    {
      name: 'evalsuite-sources',
      resolveId: {
        order: 'pre',
        handler: (id) => sources.get(id),
      },
    },
  ],
  hooks: {
    'build:done': ({ chunks }) => {
      for (const chunk of chunks) {
        const file = relative(dist, join(chunk.outDir, chunk.fileName))
        const code = chunk.type === 'chunk' ? chunk.code : String(chunk.source)
        if (/(?:\bfrom|\bimport)\s*\(?\s*['"]@evalsuite\//.test(code))
          throw new Error(`dist/${file} imports an @evalsuite/* package`)
        // src/root.ts finds the package from import.meta.url, one level below the root.
        if (file.includes('/') && code.includes('import.meta.url'))
          throw new Error(`dist/${file} uses import.meta.url outside dist/'s top level`)
      }
      for (const name of patched) {
        const bridge = join(
          dirname(realpathSync(require.resolve(`${name}/package.json`))),
          'dist/bridge',
        )
        for (const file of BRIDGE_FILES) cpSync(join(bridge, file), join(dist, 'bridge', file))
      }
      for (const [asset, from] of assets) {
        rmSync(join(here, asset), { recursive: true, force: true })
        cpSync(from, join(here, asset), { recursive: true })
      }
      if (existsSync(join(studioApp, 'index.html')))
        cpSync(studioApp, join(dist, 'studio-app'), { recursive: true })
      else
        console.warn(
          "studio-web isn't built; es studio will have no app. Run pnpm build from the repo root.",
        )
    },
  },
})
