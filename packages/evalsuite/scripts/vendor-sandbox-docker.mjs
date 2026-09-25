// Copies the built @evalsuite/sandbox-docker into dist/vendor/sandbox-docker and points dist's
// imports of it there, so the published package needs no second package. Its runtime
// dependencies must stay a subset of this package's.
import { cp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const from = fileURLToPath(new URL('../../sandbox-docker/', import.meta.url))
const dist = fileURLToPath(new URL('../dist/', import.meta.url))
const to = join(dist, 'vendor/sandbox-docker')

try {
  await stat(join(from, 'dist/index.js'))
} catch {
  console.error("sandbox-docker isn't built. Run pnpm build from the repo root.")
  process.exit(1)
}
await rm(to, { recursive: true, force: true })
await cp(join(from, 'dist'), join(to, 'dist'), {
  recursive: true,
  filter: (src) => !src.endsWith('.map'),
})
await cp(join(from, 'docker'), join(to, 'docker'), { recursive: true })

const SPECIFIER = /(['"])@evalsuite\/sandbox-docker(\/process)?\1/g

async function* files(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (path !== to) yield* files(path)
    } else if (/\.(js|d\.ts)$/.test(entry.name)) yield path
  }
}

let rewritten = 0
for await (const file of files(dist)) {
  const source = await readFile(file, 'utf8')
  const next = source.replace(SPECIFIER, (_, quote, sub) => {
    let target = relative(dirname(file), join(to, 'dist', sub ? 'process.js' : 'index.js'))
    target = target.split(sep).join('/')
    return `${quote}${target.startsWith('.') ? target : `./${target}`}${quote}`
  })
  if (next !== source) {
    await writeFile(file, next)
    rewritten++
  }
}
if (rewritten === 0) {
  console.error('No imports of @evalsuite/sandbox-docker found in dist; is the build stale?')
  process.exit(1)
}
