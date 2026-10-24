// Builds reeval's sandbox image for each baked harness, which the Docker tests need, or only the
// harnesses named. Needs Docker and `pnpm build` first.
//
//   pnpm images                     every harness: cursor, claude-code, antigravity, …
//   pnpm images claude-code codex   only those
import { BAKED_HARNESSES, buildImage, imageFor } from '../packages/sandbox-docker/dist/index.js'

const asked = process.argv.slice(2)
const unknown = asked.filter((h) => !BAKED_HARNESSES.includes(h))
if (unknown.length) {
  console.error(`Unknown harness ${unknown.join(', ')}. Use ${BAKED_HARNESSES.join(', ')}.`)
  process.exit(2)
}
for (const harness of asked.length ? asked : BAKED_HARNESSES) {
  console.log(`Building ${imageFor(harness)}`)
  await buildImage(console.log, { harness })
}
