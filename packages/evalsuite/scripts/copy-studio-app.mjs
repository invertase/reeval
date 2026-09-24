// Copies the prebuilt studio web app (packages/studio-web/dist) into dist/studio-app, so the
// published package serves it without Vite. pnpm builds studio-web first (a devDependency).
import { cp, rm, stat } from 'node:fs/promises'

const from = new URL('../../studio-web/dist/', import.meta.url)
const to = new URL('../dist/studio-app/', import.meta.url)

try {
  await stat(new URL('index.html', from))
} catch {
  console.warn(
    "studio-web isn't built; es studio will have no app. Run pnpm build from the repo root.",
  )
  process.exit(0)
}
await rm(to, { recursive: true, force: true })
await cp(from, to, { recursive: true })
