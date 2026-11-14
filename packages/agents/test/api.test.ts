// agent(): a session's start, turns and close on local(), through a real HarnessAgent with a
// scripted adapter, so key-free and with no Docker.
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { AgentError } from '../src/errors.ts'
import { local } from '../src/local.ts'
import type { Runner } from '../src/runner.ts'
import { type AgentEvent, agent } from '../src/session.ts'
import { reply, scripted } from './scripted.ts'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agents-api-'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

/** `local()` that counts its closes. */
function counted(): Runner & { closes: number } {
  const runner = local({ cwd: dir })
  const out = Object.assign(Object.create(runner) as Runner, { closes: 0 })
  out.close = async () => {
    out.closes++
    await runner.close()
  }
  return out as Runner & { closes: number }
}

const summary = (e: AgentEvent) =>
  e.type === 'phase'
    ? `phase ${e.phase}`
    : e.type === 'transcript'
      ? `transcript ${e.turn} ${e.event.type}`
      : e.type === 'warning'
        ? `warning ${e.message}`
        : `${e.type} ${e.turn}`

test('start, two turns and close run in order, placing rules and skills first', async () => {
  const script = scripted([reply('first'), reply('second')])
  const runner = counted()
  const events: AgentEvent[] = []
  const a = agent({
    harness: script.harness,
    runner,
    credentials: { CURSOR_API_KEY: 'sk-test' },
    rules: 'Be brief.\n',
    skills: [
      { name: 'home', description: 'A home skill', content: 'Do it.' },
      {
        name: 'repo',
        description: 'A repo skill',
        content: 'Do it here.',
        files: [{ path: 'notes.md', content: 'notes' }],
        placement: 'workspace',
      },
    ],
    mcp: { files: { transport: 'stdio', command: 'node', args: ['server.js'], env: {} } },
    onEvent: (e) => events.push(e),
  })
  const session = await a.start()
  assert.equal(await readFile(join(dir, 'AGENTS.md'), 'utf8'), 'Be brief.\n')
  assert.equal(
    await readFile(join(dir, '.cursor/skills/repo/SKILL.md'), 'utf8'),
    '---\nname: "repo"\ndescription: "A repo skill"\n---\nDo it here.',
  )
  assert.equal(await readFile(join(dir, '.cursor/skills/repo/notes.md'), 'utf8'), 'notes')
  const [input] = script.inputs
  assert.deepEqual(input?.auth, { CURSOR_API_KEY: 'sk-test' })
  assert.equal(input?.model, 'composer-test')
  assert.ok(input?.mcpServers && 'files' in input.mcpServers)

  const first = session.send('one')
  const seen: string[] = []
  for await (const e of first.events) seen.push(summary(e))
  const one = await first.result
  assert.equal(one.text, 'first')
  assert.equal(one.status, 'completed')
  assert.equal(one.model, 'served-model')
  assert.deepEqual(one.usage, { input: 12, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0 })
  assert.equal(seen[0], 'turn-start 0')
  assert.equal(seen.at(-1), 'turn-end 0')
  assert.ok(seen.includes('transcript 0 text'))

  const two = await session.send('two').result
  assert.equal(two.text, 'second')
  await session.close()
  await session.close()

  assert.deepEqual(script.prompts, ['one', 'two'])
  assert.deepEqual(
    script.skills.map((turn) => (turn as Array<{ name: string }>).map((s) => s.name)),
    [['home'], ['home']],
  )
  assert.deepEqual(script.calls, ['start', 'turn 0', 'turn 1', 'destroy'])
  assert.equal(runner.closes, 0, "a runner passed as is is the caller's to close")
  const order = events.map(summary).filter((s) => !s.startsWith('transcript'))
  assert.deepEqual(order, [
    'phase runner',
    'phase place',
    'phase bootstrap',
    'phase ready',
    'turn-start 0',
    'turn-end 0',
    'turn-start 1',
    'turn-end 1',
    'phase closed',
  ])
})

test("a runner from a function is the session's own, closed with it", async () => {
  const runner = counted()
  const r = await agent({ harness: scripted([reply('done')]).harness, runner: () => runner }).exec(
    'go',
  )
  assert.equal(r.text, 'done')
  assert.equal(runner.closes, 1)
})

test('credentials from a function are read on each start', async () => {
  let reads = 0
  const script = scripted([])
  const a = agent({
    harness: script.harness,
    runner: local({ cwd: dir }),
    credentials: async () => ({ CURSOR_API_KEY: `sk-${++reads}` }),
  })
  await (await a.start()).close()
  await (await a.start()).close()
  assert.deepEqual(
    script.inputs.map((i) => i.auth),
    [{ CURSOR_API_KEY: 'sk-1' }, { CURSOR_API_KEY: 'sk-2' }],
  )
})

/** A turn that streams some text, then waits for its abort. */
const hanging = (emit: (part: never) => void, signal: AbortSignal) => {
  emit({ type: 'stream-start' } as never)
  emit({ type: 'text-start', id: 't' } as never)
  emit({ type: 'text-delta', id: 't', delta: 'working' } as never)
  return new Promise<void>((_, reject) => {
    if (signal.aborted) reject(signal.reason)
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

test('aborting a turn ends it aborted, with what it streamed, and the session takes the next', async () => {
  const script = scripted([hanging, reply('after')])
  const session = await agent({
    harness: script.harness,
    runner: local({ cwd: dir }),
    parts: true,
  }).start()
  const abort = new AbortController()
  const turn = session.send('stall', { signal: abort.signal })
  for await (const e of turn.events) {
    if (e.type === 'part' && e.part.part.type === 'text-delta') abort.abort()
  }
  const r = await turn.result
  assert.equal(r.status, 'aborted')
  assert.equal((await session.send('next').result).text, 'after')
  await session.close()
})

test('a turn while one runs is refused, and so is one after close', async () => {
  const session = await agent({
    harness: scripted([hanging]).harness,
    runner: local({ cwd: dir }),
  }).start()
  const running = session.send('stall')
  assert.throws(() => session.send('again'), /already running/)
  await session.close()
  assert.equal((await running.result).status, 'aborted', 'close aborts the running turn')
  assert.throws(() => session.send('later'), AgentError)
})

test("a refused key is the turn's rejectedKey, naming the variable", async () => {
  const script = scripted([
    [
      { type: 'stream-start' },
      { type: 'error', error: new Error('HTTP 401: invalid api key') },
    ] as never,
  ])
  const r = await agent({
    harness: script.harness,
    runner: local({ cwd: dir }),
    credentials: { CURSOR_API_KEY: 'sk-bad' },
  }).exec('go')
  assert.equal(r.status, 'error')
  assert.match(
    r.rejectedKey ?? '',
    /^The API rejected CURSOR_API_KEY for the Cursor harness\. .*invalid api key/,
  )
})

test('a harness that fails to start is an AgentError, and the owned runner is closed', async () => {
  const runner = counted()
  const a = agent({
    harness: scripted([], new Error('no cursor here')).harness,
    runner: () => runner,
  })
  await assert.rejects(a.start(), (error) => {
    assert.ok(error instanceof AgentError)
    assert.match(error.message, /Cursor harness failed to start: no cursor here/)
    return true
  })
  assert.equal(runner.closes, 1)
})

test('credentials that fail to read close the owned runner, and the session is recorded failed', async () => {
  const runner = counted()
  const out = join(dir, 'out')
  const a = agent({
    harness: scripted([]).harness,
    runner: () => runner,
    credentials: () => Promise.reject(new Error('vault unreachable')),
    out,
  })
  await assert.rejects(a.start(), /vault unreachable/)
  assert.equal(runner.closes, 0, 'the runner is never made when its credentials fail')
  const doc = JSON.parse(await readFile(join(out, 'session.json'), 'utf8'))
  assert.equal(doc.status, 'failed')
  assert.equal(doc.error, 'vault unreachable')
  assert.equal(doc.adapter, undefined)
})

test('a runner made before a later step fails is closed', async () => {
  const runner = counted()
  runner.info = () => Promise.reject(new Error('no uname'))
  await assert.rejects(agent({ harness: scripted([]).harness, runner: () => runner }).start())
  assert.equal(runner.closes, 1)
})

test('close() ends a turn that ignores its abort, closes the owned runner and the session', async () => {
  const runner = counted()
  const out = join(dir, 'out')
  const warnings: string[] = []
  const ignoring = (emit: (part: never) => void) => {
    emit({ type: 'stream-start' } as never)
    return new Promise<void>(() => {})
  }
  const session = await agent({
    harness: scripted([ignoring]).harness,
    runner: () => runner,
    out,
    closeTimeoutMs: 50,
    onEvent: (e) => e.type === 'warning' && warnings.push(e.message),
  }).start()
  const turn = session.send('stall')
  await new Promise((resolve) => setTimeout(resolve, 20))
  await session.close()
  const r = await turn.result
  assert.equal(r.status, 'aborted')
  assert.deepEqual(
    r.transcript.map((e) => e.type === 'error' && e.message),
    ["The turn didn't stop within 50ms of the session closing"],
  )
  assert.equal(runner.closes, 1)
  assert.ok(warnings.includes("The turn didn't stop within 50ms of the session closing"))
  assert.equal(JSON.parse(await readFile(join(out, 'session.json'), 'utf8')).status, 'closed')
  const [line] = (await readFile(join(out, 'turns.jsonl'), 'utf8')).split('\n')
  assert.equal(JSON.parse(line as string).status, 'aborted')
})

test('a skill name or file that would leave its directory is refused before anything is written', async () => {
  for (const skill of [
    { name: '../../../escaped', description: 'd', content: 'c', placement: 'workspace' as const },
    { name: 'a/b', description: 'd', content: 'c' },
    { name: 'name\ndescription: x', description: 'd', content: 'c' },
    {
      name: 'ok',
      description: 'd',
      content: 'c',
      files: [{ path: '../../outside.md', content: 'x' }],
      placement: 'workspace' as const,
    },
    { name: 'ok', description: 'd', content: 'c', files: [{ path: '/etc/x', content: 'x' }] },
  ]) {
    const script = scripted([])
    await assert.rejects(
      agent({
        harness: script.harness,
        runner: local({ cwd: dir }),
        workDir: 'a/b/c',
        skills: [skill],
      }).start(),
      (error) => error instanceof AgentError && /skill/.test(error.message),
    )
    assert.deepEqual(script.inputs, [], 'refused before the adapter is built')
  }
  assert.deepEqual(await readdir(dir), [])
})
