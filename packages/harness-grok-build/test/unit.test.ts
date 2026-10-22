import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  createGrokBuild,
  GROK_CLI_INTEGRITY,
  GROK_CLI_VERSION,
  GROK_CREDENTIAL_ENV,
  GROK_INSTALL_COMMAND,
  GROK_PLUGIN_DIRS_ENV,
  grokConfig,
} from '../src/grok-build-harness.ts'
import { GROK_BUILD_BUILTIN_TOOLS } from '../src/grok-build-tools.ts'
import { VERSION } from '../src/version.ts'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test("VERSION is package.json's", () => {
  assert.equal(VERSION, pkg.version)
})

test('the install downloads the pinned native build and checks its sha512 on both arches', () => {
  assert.ok(
    GROK_INSTALL_COMMAND.includes(
      `/@xai-official/grok-linux-$arch/-/grok-linux-$arch-${GROK_CLI_VERSION}.tgz`,
    ),
  )
  for (const sri of Object.values(GROK_CLI_INTEGRITY)) {
    assert.match(sri, /^sha512-[A-Za-z0-9+/]{86}==$/)
    assert.ok(GROK_INSTALL_COMMAND.includes(`sri=${sri}`))
  }
  assert.ok(GROK_INSTALL_COMMAND.includes('does not match its sha512'))
})

test('auth is an environment with the xAI key, or it throws', () => {
  assert.throws(
    () => createGrokBuild({ auth: {}, model: 'm' }),
    /Grok Build auth must be an environment object with XAI_API_KEY/,
  )
  const harness = createGrokBuild({ auth: { [GROK_CREDENTIAL_ENV]: 'xai-k' }, model: 'm' })
  assert.equal(harness.harnessId, 'grok-build')
})

test("with requireCredentialBrokering, a sandbox that can't broker never gets the key", async () => {
  const harness = createGrokBuild({
    auth: { [GROK_CREDENTIAL_ENV]: 'xai-k' },
    model: 'm',
    requireCredentialBrokering: true,
  })
  await assert.rejects(
    harness.doStart({ sandboxSession: { run: async () => ({}) } } as never),
    /The sandbox can't broker XAI_API_KEY .* so the key stays out of it/,
  )
})

test("config.toml puts every call on the run's model and turns off the extra calls", () => {
  const file = grokConfig({ model: 'grok-4.6' })
  assert.equal(file.path, '.grok/config.toml')
  assert.match(file.content, /^\[models\]\ndefault = "grok-4\.6"\nsession_summary = "grok-4\.6"\n/)
  for (const off of [
    'telemetry',
    'feedback',
    'managed_config',
    'campaigns',
    'title_refresh',
    'turn_summary',
    'session_recap',
    'auto_update',
  ]) {
    assert.ok(file.content.includes(`\n${off} = false\n`), off)
  }
  assert.equal(file.content.includes('default_reasoning_effort'), false)
})

// grok-acp runs in reeval's Linux sandbox; Windows can't run it or the stand-in grok, extensionless
// scripts with a shebang.
const posixOnly = process.platform === 'win32' && 'grok-acp and its stand-in are POSIX scripts'

test('grok-acp starts grok agent --no-leader stdio with a --plugin-dir for each plugin directory', {
  skip: posixOnly,
}, (t) => {
  const home = mkdtempSync(join(tmpdir(), 'grok-acp-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const bin = join(home, '.local/bin')
  const launcher =
    /cat > "\$HOME\/\.local\/bin\/grok-acp" <<'GROK_LAUNCH'\n([\s\S]*?)GROK_LAUNCH\n/.exec(
      GROK_INSTALL_COMMAND,
    )?.[1]
  assert.ok(launcher, 'the install writes grok-acp')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'grok-acp'), launcher, { mode: 0o755 })
  writeFileSync(join(bin, 'grok'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 })
  const argv = (dirs: string) =>
    execFileSync(join(bin, 'grok-acp'), {
      env: { PATH: process.env.PATH, [GROK_PLUGIN_DIRS_ENV]: dirs },
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
  assert.deepEqual(argv(''), ['agent', '--no-leader', 'stdio'])
  assert.deepEqual(argv('/h/.reeval/plugins/probe:/h/.reeval/plugins/r*'), [
    'agent',
    '--no-leader',
    '--plugin-dir',
    '/h/.reeval/plugins/probe',
    '--plugin-dir',
    '/h/.reeval/plugins/r*',
    'stdio',
  ])
})

test('plugin directories leave the bootstrap an image bakes unchanged', async () => {
  const bootstrap = (pluginDirs?: string[]) =>
    createGrokBuild({
      auth: { [GROK_CREDENTIAL_ENV]: 'xai-k' },
      model: 'm',
      ...(pluginDirs ? { pluginDirs } : {}),
    }).getBootstrap?.({})
  assert.deepEqual(await bootstrap(['/h/.reeval/plugins/probe']), await bootstrap())
})

test("effort is the config's default_reasoning_effort", () => {
  assert.match(
    grokConfig({ model: 'grok-4.6', effort: 'high' }).content,
    /\ndefault_reasoning_effort = "high"\n/,
  )
})

test('the catalog names the tools Grok calls by its own names (CLI 1.0.62)', () => {
  for (const name of ['search_tool', 'spawn_subagent'])
    assert.ok(name in GROK_BUILD_BUILTIN_TOOLS, `${name} is in the catalog`)
  assert.equal(GROK_BUILD_BUILTIN_TOOLS.search_tool.toolUseKind, 'readonly')
})
