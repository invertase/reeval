// A real image registry for the Docker tier's `--registry` tests: the Distribution project's
// registry:2 in a container on a loopback port, which Docker pushes to over plain HTTP since it's
// on localhost.
import { execFileSync } from 'node:child_process'

export const REGISTRY_IMAGE =
  'registry:2@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373'

export type Registry = { prefix: string; close(): void }

/** Starts a registry, once it answers, and returns the prefix reeval's `--registry` takes for it. */
export async function startRegistry(path = 'reeval'): Promise<Registry> {
  const id = execFileSync(
    'docker',
    ['run', '-d', '--rm', '-p', '127.0.0.1::5000', REGISTRY_IMAGE],
    {
      encoding: 'utf8',
    },
  ).trim()
  const port = execFileSync('docker', ['port', id, '5000/tcp'], { encoding: 'utf8' })
    .trim()
    .split('\n')[0]
    ?.split(':')
    .at(-1)
  for (let tries = 0; ; tries++) {
    const up = await fetch(`http://127.0.0.1:${port}/v2/`).then(
      (r) => r.ok,
      () => false,
    )
    if (up) break
    if (tries === 50) throw new Error(`registry:2 on port ${port} never answered`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return {
    prefix: `127.0.0.1:${port}/${path}`,
    close: () => {
      execFileSync('docker', ['rm', '-f', id], { stdio: 'ignore' })
    },
  }
}
