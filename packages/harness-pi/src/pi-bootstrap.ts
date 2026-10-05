import { readFile } from 'node:fs/promises'
import type { HarnessV1Bootstrap } from '@ai-sdk/harness'

/** The pi release the bootstrap installs, pinned with its whole dependency tree in `assets/`. */
export const PI_CLI_VERSION = '1.0.2'
/** Relative to the harness state directory, `$HOME/.ai-sdk-harness`. */
export const PI_BOOTSTRAP_DIR = '.harness-bootstrap/pi'
/** The CLI's path relative to the bootstrap directory. */
export const PI_CLI_PATH = 'node_modules/.bin/pi'

const ASSETS = new URL('../assets/', import.meta.url)
const asset = (name: string) => readFile(new URL(name, ASSETS), 'utf8')

/**
 * Installs pi from its lockfile. pi runs without the build scripts of `@google/genai`, `esbuild`
 * and `protobufjs`, so none run.
 */
export async function getPiBootstrap(): Promise<HarnessV1Bootstrap> {
  const [manifest, lockfile] = await Promise.all([asset('package.json'), asset('pnpm-lock.yaml')])
  return {
    harnessId: 'pi',
    bootstrapDir: PI_BOOTSTRAP_DIR,
    files: [
      { path: `${PI_BOOTSTRAP_DIR}/package.json`, content: manifest },
      { path: `${PI_BOOTSTRAP_DIR}/pnpm-lock.yaml`, content: lockfile },
    ],
    commands: [{ command: 'pnpm install --frozen-lockfile --prod --ignore-scripts' }],
  }
}
