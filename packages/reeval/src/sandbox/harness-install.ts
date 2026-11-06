// A harness's CLI installed in a machine reeval doesn't build with Docker: Tart's preflight bakes
// it into an image each attempt clones, and `boat()` installs it as each VM starts. Both run the
// bootstrap Docker's images bake, so an attempt's harness finds its marker and skips the install.
import {
  adapterVersion,
  bakedHarnessName,
  bakedRecipe,
  bakeHarness,
  type DockerSession,
  isBakedHarness,
  PNPM_VERSION,
} from '@reeval/sandbox-docker'
import { shellQuote as q } from '@reeval/sandbox-docker/process'
import { fakeBootstrapId, fakeBootstrapScript } from '../harness/fake-bootstrap.ts'
import type { HarnessDescriptor } from '../types.ts'

/**
 * What a harness bakes into a Tart image, or installs in a `boat()` VM as it starts: its name in
 * the image's, and how to install it.
 */
export type HarnessBake = {
  /** The harness and its adapter version (with the patch hash, as Docker's tags have it). */
  label: string
  /** The harness kind, which every bake of it starts its label with. */
  kind: string
  /** How progress names it. */
  name: string
  /** Whether the image gets reeval's pinned pnpm, which the harness bridges install with. */
  pnpm: boolean
  /** A hash of what the bake runs, so a changed bootstrap bakes anew without a version bump. */
  recipe: () => Promise<string>
  /** Installs the CLI in `session` and returns the version it installed. */
  install: (session: DockerSession) => Promise<string>
}

/** The bake `harness` needs in `tart()` or `boat()`; null for a fake agent with nothing to install. */
export function harnessBake(harness: HarnessDescriptor): HarnessBake | null {
  if (harness.kind === 'fake') {
    const command = harness.bootstrap
    if (!command) return null
    return {
      label: `fake-${fakeBootstrapId(command)}`,
      kind: 'fake',
      name: "the fake agent's bootstrap",
      pnpm: false,
      recipe: async () => fakeBootstrapScript(command),
      async install(session) {
        const r = await session.run({ command: fakeBootstrapScript(command) })
        if (r.exitCode !== 0) {
          throw new Error(
            `The fake agent's bootstrap exited ${r.exitCode}: ${(r.stderr || r.stdout).trim().slice(-500)}`,
          )
        }
        return 'fake'
      },
    }
  }
  const kind = harness.kind
  if (!isBakedHarness(kind)) return null
  return {
    label: `${kind}-${adapterVersion(kind)}`,
    kind,
    name: bakedHarnessName(kind),
    pnpm: true,
    recipe: () => bakedRecipe(kind),
    install: (session) => bakeHarness(session, kind),
  }
}

/**
 * Installs what `bake` puts in a Tart image or a `boat()` VM, as the session's user: reeval's
 * pinned pnpm when it asks for it (into `pnpmPrefix`, or npm's global prefix), then the CLI.
 * Returns the CLI's version.
 */
export async function installHarness(
  session: DockerSession,
  bake: HarnessBake,
  o: { pnpmPrefix?: string; signal?: AbortSignal; log?: (line: string) => void } = {},
): Promise<string> {
  if (bake.pnpm) {
    o.log?.(`Installing pnpm ${PNPM_VERSION}`)
    const prefix = o.pnpmPrefix ? ` --prefix ${q(o.pnpmPrefix)}` : ''
    const r = await session.run({
      command: `npm install --global --no-fund --no-audit${prefix} pnpm@${PNPM_VERSION} && pnpm --version`,
      ...(o.signal && { abortSignal: o.signal }),
    })
    if (r.exitCode !== 0) {
      throw new Error(
        `npm install pnpm@${PNPM_VERSION} exited ${r.exitCode}: ${(r.stderr || r.stdout).trim().slice(-500)}`,
      )
    }
  }
  o.log?.(`Installing ${bake.name}`)
  return bake.install(session)
}
