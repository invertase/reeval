// setupOf(), the install modes and the marker they share with the AI SDK, on local() with a toy
// adapter whose install counts its runs, so key-free and with no Docker.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { HarnessV1, HarnessV1Bootstrap } from '@ai-sdk/harness'
import { createHarnessSandboxTemplate } from '@ai-sdk/harness/agent'
import type { AgentKind } from '../src/catalog/entry.ts'
import { HARNESSES } from '../src/catalog/index.ts'
import { AgentError } from '../src/errors.ts'
import { local } from '../src/local.ts'
import { runnerSession } from '../src/runner-session.ts'
import { type AgentEvent, agent } from '../src/session.ts'
import { installHarness, recipeMarker, setupOf } from '../src/setup.ts'
import { reply, scripted } from './scripted.ts'

// Everything an install writes lands under HOME, which local() and its commands take from here.
const home = mkdtempSync(join(tmpdir(), 'reeval-agents-home-'))
process.env.HOME = home
after(() => rmSync(home, { recursive: true, force: true }))

let toys = 0
/** A recipe of its own each time, which appends a line to `runs` in `dir` whenever it runs. */
function toy(): { recipe: HarnessV1Bootstrap; adapter: HarnessV1; runs: () => number } {
  const dir = mkdtempSync(join(tmpdir(), 'reeval-agents-toy-'))
  const recipe: HarnessV1Bootstrap = {
    harnessId: `toy-${++toys}`,
    bootstrapDir: `.harness-bootstrap/toy-${toys}`,
    files: [{ path: `.harness-bootstrap/toy-${toys}/install.sh`, content: `echo ran >> runs\n` }],
    commands: [
      {
        command: `cd '${dir}' && sh "$HOME/.ai-sdk-harness/.harness-bootstrap/toy-${toys}/install.sh"`,
      },
    ],
  }
  const adapter = {
    harnessId: recipe.harnessId,
    getBootstrap: async () => recipe,
  } as unknown as HarnessV1
  const runs = () => {
    try {
      return readFileSync(join(dir, 'runs'), 'utf8').split('\n').filter(Boolean).length
    } catch {
      return 0
    }
  }
  return { recipe, adapter, runs }
}

const workspace = () => mkdtempSync(join(tmpdir(), 'reeval-agents-ws-'))

test('the marker it checks is the one the AI SDK writes', async () => {
  const { recipe, adapter, runs } = toy()
  const runner = local({ cwd: workspace() })
  const template = await createHarnessSandboxTemplate({
    harnesses: [adapter],
    sandboxConfig: { workDir: '.' },
  })
  await template?.prepare({ session: await runnerSession(runner) })
  assert.equal(runs(), 1)
  assert.notEqual(await runner.readFile(await recipeMarker(recipe, home)), null)
  await installHarness({ runner, home, adapter, name: 'Toy', mode: 'skip', workDir: '.' })
  await installHarness({ runner, home, adapter, name: 'Toy', mode: 'auto', workDir: '.' })
  assert.equal(runs(), 1, 'neither installs what the AI SDK already did')
})

test('auto installs once, always every time, and skip refuses a runner without it', async () => {
  const { adapter, runs } = toy()
  const runner = local({ cwd: workspace() })
  const install = (mode: 'auto' | 'skip' | 'always') =>
    installHarness({ runner, home, adapter, name: 'Toy', mode, workDir: '.' })
  await assert.rejects(
    install('skip'),
    (e) => e instanceof AgentError && /install is 'skip'/.test(e.message),
  )
  assert.equal(runs(), 0)
  assert.equal(await install('auto'), true)
  await install('auto')
  assert.equal(runs(), 1)
  await install('always')
  assert.equal(runs(), 2)
  assert.equal(await install('skip'), false)
  assert.equal(runs(), 2)
})

test('an adapter with nothing to install installs nothing, whatever the mode', async () => {
  const runner = local({ cwd: workspace() })
  const adapter = { harnessId: 'bare' } as unknown as HarnessV1
  for (const mode of ['auto', 'skip', 'always'] as const) {
    assert.equal(
      await installHarness({ runner, home, adapter, name: 'Bare', mode, workDir: '.' }),
      false,
    )
  }
})

test('a session times its install as a phase, before the harness starts', async () => {
  const { adapter: install, runs } = toy()
  const script = scripted([reply('done')])
  const harness = {
    ...script.harness,
    adapter: async (input: Parameters<typeof script.harness.adapter>[0]) =>
      Object.assign(Object.create(await script.harness.adapter(input)), {
        getBootstrap: install.getBootstrap,
      }) as HarnessV1,
  }
  const out = workspace()
  const events: AgentEvent[] = []
  const session = await agent({
    harness,
    runner: local({ cwd: workspace() }),
    out,
    onEvent: (e) => events.push(e),
  }).start()
  await session.close()
  assert.equal(runs(), 1)
  const phases = events.flatMap((e) => (e.type === 'phase' ? [e.phase] : []))
  assert.deepEqual(phases, ['runner', 'place', 'install', 'bootstrap', 'ready', 'closed'])
  const doc = JSON.parse(readFileSync(join(out, 'session.json'), 'utf8'))
  assert.equal(typeof doc.phases.install, 'number')

  const skipped = await agent({
    harness,
    runner: local({ cwd: workspace() }),
    install: 'skip',
  }).start()
  await skipped.close()
  assert.equal(runs(), 1, 'skip found it installed')
})

test("a session with install: 'skip' fails to start on a runner without the CLI", async () => {
  const { adapter: install, runs } = toy()
  const script = scripted([])
  const harness = {
    ...script.harness,
    adapter: async (input: Parameters<typeof script.harness.adapter>[0]) =>
      Object.assign(Object.create(await script.harness.adapter(input)), {
        getBootstrap: install.getBootstrap,
      }) as HarnessV1,
  }
  await assert.rejects(
    agent({ harness, runner: local({ cwd: workspace() }), install: 'skip' }).start(),
    /doesn't have this build of the Cursor CLI installed/,
  )
  assert.equal(runs(), 0)
  assert.deepEqual(script.calls, [], 'the harness never started')
})

test('setupOf names each harness, its credentials and an install recipe', async () => {
  for (const kind of Object.keys(HARNESSES) as AgentKind[]) {
    const setup = setupOf(kind)
    assert.equal(setup.name, HARNESSES[kind].name)
    assert.ok(setup.cli, kind)
    assert.deepEqual(setup.platforms, HARNESSES[kind].platforms)
    const recipe = await setup.recipe()
    assert.ok(
      recipe && recipe.commands.length + recipe.files.length > 0,
      `${kind} installs something`,
    )
  }
  assert.deepEqual(setupOf('claude-code').credentials, [
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
  ])
  assert.deepEqual(setupOf('codex').credentials, ['OPENAI_API_KEY'])
  assert.deepEqual(setupOf('pi').credentials, [], "pi's key is its model's provider's")
})
