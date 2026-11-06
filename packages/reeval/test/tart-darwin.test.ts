// The darwin branches of the harness bootstraps `tart()` bakes: on a macOS host, the fake `tart`
// runs each bake's commands on the host itself, so the real bootstraps of every harness tart() runs
// download and check their macOS builds, pnpm installs, and each CLI answers `--version`. No key
// and no VM. CI's macOS job sets REEVAL_TEST_DARWIN_BOOTSTRAPS=1, which fails it off macOS.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { before, describe, test } from 'node:test'
import { ANTIGRAVITY_CLI_VERSION } from '@reeval/harness-antigravity'
import { CODEX_CLI_VERSION } from '@reeval/harness-codex'
import { FX_CLI_VERSION } from '@reeval/harness-fx'
import { GOOSE_CLI_VERSION } from '@reeval/harness-goose'
import { GROK_CLI_VERSION } from '@reeval/harness-grok-build'
import { OPENCODE_CLI_VERSION } from '@reeval/harness-opencode'
import { PI_CLI_VERSION } from '@reeval/harness-pi'
import { BAKED_HARNESSES, PNPM_VERSION } from '@reeval/sandbox-docker'
import { type HarnessBake, harnessBake } from '../src/sandbox/harness-install.ts'
import { bakeTartImage } from '../src/sandbox/tart-bake.ts'
import { tartCli } from '../src/sandbox/tart-cli.ts'
import { fakeDigest, installFakeTart } from './support/fake-tart.ts'

const asked = process.env.REEVAL_TEST_DARWIN_BOOTSTRAPS === '1'
const darwin = process.platform === 'darwin' && process.arch === 'arm64'
const skip = asked
  ? false
  : 'the macOS bootstraps download each CLI: set REEVAL_TEST_DARWIN_BOOTSTRAPS=1 on an Apple Silicon Mac'
const IMAGE = 'ghcr.io/cirruslabs/macos-sequoia-base:latest'
const harnesses = BAKED_HARNESSES
const literally = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** The `--version` each bake records: the pinned CLI, not whatever executable came first. */
const AGENT_VERSION: Record<string, RegExp> = {
  'claude-code': /^\d+\.\d+\.\d+ \(Claude Code\)$/,
  antigravity: new RegExp(`^${literally(ANTIGRAVITY_CLI_VERSION)}$`),
  opencode: new RegExp(`^opencode v${literally(OPENCODE_CLI_VERSION)}$`),
  goose: new RegExp(`${literally(GOOSE_CLI_VERSION)}$`),
  pi: new RegExp(`^${literally(PI_CLI_VERSION)}$`),
  codex: new RegExp(`^codex-cli ${literally(CODEX_CLI_VERSION)}$`),
  fx: new RegExp(`${literally(FX_CLI_VERSION)}$`),
  'grok-build': new RegExp(`^grok ${literally(GROK_CLI_VERSION)}\\b`),
}

describe('harness bootstraps on macOS', { skip }, () => {
  let fake: ReturnType<typeof installFakeTart>
  before(() => {
    assert.ok(
      darwin,
      `REEVAL_TEST_DARWIN_BOOTSTRAPS=1 needs macOS on arm64 (this is ${process.platform}-${process.arch})`,
    )
    fake = installFakeTart([IMAGE])
  })

  for (const kind of harnesses) {
    test(`${kind} bakes with its macOS build`, { timeout: 600_000 }, async () => {
      const bake = harnessBake({ kind } as Parameters<typeof harnessBake>[0]) as HarnessBake
      const lines: string[] = []
      const baked = await bakeTartImage({ kind: 'tart', image: IMAGE }, bake, {
        source: fakeDigest(IMAGE),
        signal: new AbortController().signal,
        log: (l) => lines.push(l),
      })
      try {
        assert.equal(baked.built, true, lines.join('\n'))
        assert.match(baked.agentVersion ?? '', AGENT_VERSION[kind] ?? /\d+\.\d+/, lines.join('\n'))
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
