// The darwin branches of the harness bootstraps `tart()` bakes: on a macOS host, the fake `tart`
// runs each bake's commands on the host itself, so the real Cursor, pi and Codex bootstraps
// download and check their macOS builds, pnpm installs, and each CLI answers `--version`. No key
// and no VM. CI's macOS job sets REEVAL_TEST_DARWIN_BOOTSTRAPS=1, which fails it off macOS.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { before, describe, test } from 'node:test'
import { PNPM_VERSION } from '@reeval/sandbox-docker'
import { bakeTartImage, type TartBake, tartBake } from '../src/sandbox/tart-bake.ts'
import { tartCli } from '../src/sandbox/tart-cli.ts'
import { fakeDigest, installFakeTart } from './support/fake-tart.ts'

const asked = process.env.REEVAL_TEST_DARWIN_BOOTSTRAPS === '1'
const darwin = process.platform === 'darwin' && process.arch === 'arm64'
const skip = asked
  ? false
  : 'the macOS bootstraps download each CLI: set REEVAL_TEST_DARWIN_BOOTSTRAPS=1 on an Apple Silicon Mac'
const IMAGE = 'ghcr.io/cirruslabs/macos-sequoia-base:latest'

describe('harness bootstraps on macOS', { skip }, () => {
  let fake: ReturnType<typeof installFakeTart>
  before(() => {
    assert.ok(
      darwin,
      `REEVAL_TEST_DARWIN_BOOTSTRAPS=1 needs macOS on arm64 (this is ${process.platform}-${process.arch})`,
    )
    fake = installFakeTart([IMAGE])
  })

  for (const kind of ['cursor', 'pi', 'codex'] as const) {
    test(`${kind} bakes with its macOS build`, { timeout: 600_000 }, async () => {
      const bake = tartBake({ kind } as Parameters<typeof tartBake>[0]) as TartBake
      const lines: string[] = []
      const baked = await bakeTartImage({ kind: 'tart', image: IMAGE }, bake, {
        digest: fakeDigest(IMAGE),
        signal: new AbortController().signal,
        log: (l) => lines.push(l),
      })
      try {
        assert.equal(baked.built, true, lines.join('\n'))
        assert.match(baked.agentVersion ?? '', /\d+\.\d+/, lines.join('\n'))
        const home = join(fake.dir, 'vms', baked.image, 'home')
        const pnpm = execFileSync(join(home, '.reeval-state/pnpm/bin/pnpm'), ['--version'], {
          encoding: 'utf8',
        })
        assert.equal(pnpm.trim(), PNPM_VERSION)
        const markers = execFileSync('find', [home, '-maxdepth', '5', '-name', '.bootstrap-*.ok'], {
          encoding: 'utf8',
        })
        assert.ok(markers.trim(), 'the bootstrap left its marker, so an attempt skips the install')
      } finally {
        await tartCli(['delete', baked.image])
      }
    })
  }
})
