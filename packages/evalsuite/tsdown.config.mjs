// Bundles @invertase/foobar with tsdown. The workspace's @evalsuite/* packages are private and
// inlined from their TypeScript sources, so the published package imports only its own
// `dependencies`. What ships next to the code: sandbox-docker's `docker/` build context (at the
// package root, beside `dist/`, where sandbox-docker's `../docker` finds it) and the prebuilt
// studio app (`dist/studio-app`).
import { cpSync, existsSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { defineConfig } from 'tsdown'

const here = import.meta.dirname
const require = createRequire(import.meta.url)
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))

/** `@evalsuite/<name>[/sub]` → its source file, from each workspace package's `exports`. */
const sources = new Map()
for (const name of Object.keys(pkg.devDependencies).filter((d) => d.startsWith('@evalsuite/'))) {
  const dir = dirname(realpathSync(require.resolve(`${name}/package.json`)))
  const { exports } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  for (const [sub, target] of Object.entries(exports)) {
    if (typeof target === 'string') continue // ./package.json
    const file = join(dir, target.default.replace(/^\.\/dist\/(.*)\.js$/, 'src/$1.ts'))
    if (!existsSync(file)) throw new Error(`${name}: no source for ${sub} (${file})`)
    sources.set(join(name, sub), file)
  }
}

const dist = join(here, 'dist')
const dockerContext = join(dirname(sources.get('@evalsuite/sandbox-docker')), '../docker')
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
    alwaysBundle: [/^@evalsuite\//],
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
      rmSync(join(here, 'docker'), { recursive: true, force: true })
      cpSync(dockerContext, join(here, 'docker'), { recursive: true })
      if (existsSync(join(studioApp, 'index.html')))
        cpSync(studioApp, join(dist, 'studio-app'), { recursive: true })
      else
        console.warn(
          "studio-web isn't built; es studio will have no app. Run pnpm build from the repo root.",
        )
    },
  },
})
