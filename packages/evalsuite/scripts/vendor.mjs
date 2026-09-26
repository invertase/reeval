// Copies the built @evalsuite/sandbox-docker, @evalsuite/harness-antigravity,
// @evalsuite/harness-opencode and @evalsuite/harness-cursor-sdk into dist/vendor/<name> and points dist's imports of them there (including the vendored copies'
// imports of each other), so the published package needs no second package. Their runtime
// dependencies must stay a subset of this package's.
import { cp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))

const VENDORED = [
  {
    name: 'sandbox-docker',
    subpaths: { '': 'index.js', '/process': 'process.js' },
    extra: ['docker'],
  },
  { name: 'harness-antigravity', subpaths: { '': 'index.js' }, extra: [] },
  { name: 'harness-opencode', subpaths: { '': 'index.js' }, extra: [] },
  { name: 'harness-cursor-sdk', subpaths: { '': 'index.js' }, extra: [] },
].map((v) => ({
  ...v,
  from: fileURLToPath(new URL(`../../${v.name}/`, import.meta.url)),
  to: join(dist, 'vendor', v.name),
}))

for (const v of VENDORED) {
  try {
    await stat(join(v.from, 'dist/index.js'))
  } catch {
    console.error(`${v.name} isn't built. Run pnpm build from the repo root.`)
    process.exit(1)
  }
  await rm(v.to, { recursive: true, force: true })
  await cp(join(v.from, 'dist'), join(v.to, 'dist'), {
    recursive: true,
    filter: (src) => !src.endsWith('.map'),
  })
  for (const dir of v.extra) await cp(join(v.from, dir), join(v.to, dir), { recursive: true })
}

async function* files(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* files(path)
    else if (/\.(js|d\.ts)$/.test(entry.name)) yield path
  }
}

const rewritten = new Map(VENDORED.map((v) => [v.name, 0]))
for await (const file of files(dist)) {
  let source = await readFile(file, 'utf8')
  const original = source
  for (const v of VENDORED) {
    // Only module specifiers (`from '…'`, `import('…')`), not other strings that name the package.
    const specifier = new RegExp(
      `((?:\\bfrom|\\bimport)\\s*\\(?\\s*)(['"])@evalsuite/${v.name}(/[a-z-]+)?\\2`,
      'g',
    )
    source = source.replace(specifier, (match, keyword, quote, sub = '') => {
      const target = v.subpaths[sub]
      if (!target) return match
      if (!file.startsWith(v.to)) rewritten.set(v.name, rewritten.get(v.name) + 1)
      let path = relative(dirname(file), join(v.to, 'dist', target))
        .split(sep)
        .join('/')
      if (!path.startsWith('.')) path = `./${path}`
      return `${keyword}${quote}${path}${quote}`
    })
  }
  if (source !== original) await writeFile(file, source)
}
for (const [name, count] of rewritten) {
  if (count === 0) {
    console.error(`No imports of @evalsuite/${name} found in dist; is the build stale?`)
    process.exit(1)
  }
}
