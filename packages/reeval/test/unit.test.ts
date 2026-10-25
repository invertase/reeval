import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { shellQuote } from '@reeval/sandbox-docker/process'
import { createChecks } from '../src/attempt/checks.ts'
import { traceEnvironment } from '../src/attempt/debug.ts'
import type { Attempt, AttemptSpec } from '../src/attempt/state.ts'
import {
  CONFIG_FILES,
  defaultConcurrency,
  evalRoot,
  findConfig,
  loadConfig,
  malformedCredentials,
  missingConfigMessage,
  missingCredentials,
  parseDuration,
  requireConfig,
  resolveConcurrency,
  resolveConfig,
  selectProfile,
  UsageError,
} from '../src/config.ts'
import type { AttemptDebug } from '../src/debug/attempt.ts'
import { acceptIntoSnapshot, diffSinceSnapshot, snapshot } from '../src/diff.ts'
import type { ResolvedEnvironment } from '../src/environment/resolve.ts'
import { excludeMatcher, parseSkillMd, resolveEnvironment } from '../src/environment/resolve.ts'
import {
  applied,
  DEFAULT_DIRECTORY_IGNORES,
  DEFAULT_SKILL_EXCLUDE,
  defineEnvironment,
  globFilter,
  helpersFor,
  isMovingRef,
  parseGitRepo,
} from '../src/environment.ts'
import { isTimeout, TimeoutError } from '../src/errors.ts'
import { vercel } from '../src/gateway.ts'
import {
  AGENTS,
  type AgentKind,
  agentAuth,
  agentFor,
  authHint,
  brokeringFor,
} from '../src/harness/agents.ts'
import { createFakeHarness } from '../src/harness/fake.ts'
import { capText, OUTPUT_CAP } from '../src/history/assemble.ts'
import { warnings } from '../src/history/state.ts'
import type { HistoryEntry, RunRecord } from '../src/history/types.ts'
import { compare, stackChanges } from '../src/history/views.ts'
import { newRunId, RUN_ID } from '../src/ids.ts'
import {
  badJudgeArtifacts,
  decideState,
  filePartsOf,
  resolveJudgeArtifacts,
} from '../src/judge/artifacts.ts'
import { checkModelString, judgeCredentials, judgeRoute, runJudge } from '../src/judge/index.ts'
import { scoreWithModel } from '../src/judge/model.ts'
import { changedFilesForJudge, judgeDiff, patchForJudge } from '../src/judge/patch.ts'
import { backoffMs, isApiError, isTransient } from '../src/judge/retry.ts'
import { withInputSize } from '../src/judge/size.ts'
import { fakeJudge } from '../src/judge.ts'
import { cascade, checkOptions, expand, type Resolved } from '../src/options.ts'
import { redactSecrets } from '../src/redact.ts'
import { createFakeSandbox, posixShell } from '../src/sandbox/fake.ts'
import { fakeSandbox } from '../src/sandbox.ts'
import { clip } from '../src/text.ts'
import type { GatewayDescriptor, Outcome } from '../src/types.ts'
import { rowKey } from '../src/view/compare.ts'
import { gatePart } from '../src/view/gate.ts'
import { splitPatch } from '../src/view/patch.ts'
import { project } from './helpers.ts'

test("the -v broker line names each brokered endpoint's path matcher", () => {
  const brokerLine = (kind: AgentKind, model = 'm') => {
    const lines: string[] = []
    const debug = {
      log: (phase: string, text: string) => lines.push(`${phase} ${text}`),
      trace() {},
    }
    const record = {
      name: 'e',
      digest: 'sha256:0',
      overrides: [],
      unset: [],
      vars: [],
      secrets: [],
    }
    traceEnvironment(
      debug as unknown as AttemptDebug,
      { harness: { kind, model } } as unknown as AttemptSpec,
      {
        record,
        substitutions: [],
        vars: {},
        checkVars: {},
        files: [],
        skills: [],
        workspaceSkills: [],
        plugins: [],
        mcp: {},
      } as unknown as ResolvedEnvironment,
    )
    return lines.filter((l) => l.startsWith('broker '))
  }
  assert.deepEqual(brokerLine('antigravity'), [
    'broker GEMINI_API_KEY stays on the host · the gateway swaps it in on POST generativelanguage.googleapis.com (path ~ /^/v1beta/models/[^/]+:streamGenerateContent$/)',
  ])
  assert.deepEqual(brokerLine('cursor'), [
    'broker CURSOR_API_KEY stays on the host · the gateway swaps it in on POST api2.cursor.sh/auth/exchange_user_api_key',
  ])
  assert.deepEqual(brokerLine('opencode', 'anthropic/claude-haiku-4-5'), [
    'broker ANTHROPIC_API_KEY stays on the host · the gateway swaps it in on POST api.anthropic.com/v1/messages',
  ])
  for (const kind of Object.keys(AGENTS) as AgentKind[]) {
    const model = kind === 'opencode' ? 'google/m' : 'm'
    assert.doesNotMatch(brokerLine(kind, model).join('\n'), /\[object /, kind)
  }
})

test("a harness's auth is only its own credential, and a missing one fails closed", () => {
  const host = { CURSOR_API_KEY: 'crsr_k', AI_GATEWAY_API_KEY: 'gw_k', ANTHROPIC_API_KEY: 'sk-a' }
  assert.deepEqual(agentAuth(AGENTS.cursor, host), { CURSOR_API_KEY: 'crsr_k' })
  assert.throws(
    () => agentAuth(AGENTS.cursor, { AI_GATEWAY_API_KEY: 'gw_k' }),
    /^InfraError: CURSOR_API_KEY isn't set, so the Cursor harness can't authenticate/,
  )
  assert.deepEqual(brokeringFor({ kind: 'cursor', model: 'composer-2.5' }), {
    credential: 'CURSOR_API_KEY',
    endpoints: AGENTS.cursor.endpoints,
    tokens: { name: 'CURSOR_API_KEY', ...AGENTS.cursor.tokens },
  })
  assert.equal(brokeringFor({ kind: 'fake' }), undefined)
})

test('run ids sort by start time and differ for runs in the same second', () => {
  const start = new Date('2026-09-24T15:27:00.123Z')
  const a = newRunId(start, '009763c1234', 'elliot-hesp')
  const b = newRunId(start, '009763c1234', 'elliot-hesp')
  assert.match(a, /^20260924T152700Z_009763c_elliot-hesp_[0-9a-z]{4}$/)
  assert.match(a, RUN_ID)
  assert.notEqual(a, b, 'same second, commit and author: still two runs')
  assert.equal(newRunId(start, null, 'x', 'abcd'), '20260924T152700Z_nogit_x_abcd')
  const later = newRunId(new Date('2026-09-24T15:27:01Z'), null, 'a', '0000')
  assert.ok(later > newRunId(start, null, 'z', 'zzzz'), 'the stamp orders runs first')
})

test("the fake sandbox's shell: sh, or on Windows the sh.exe on PATH or Git for Windows'", () => {
  assert.equal(
    posixShell('linux', {}, () => false),
    'sh',
  )
  const has = (path: string) => (p: string) => p === path
  assert.equal(
    posixShell(
      'win32',
      { PATH: 'C:\\tools;D:\\msys\\usr\\bin' },
      has('D:\\msys\\usr\\bin\\sh.exe'),
    ),
    'D:\\msys\\usr\\bin\\sh.exe',
  )
  const git = 'C:\\Program Files\\Git\\bin\\sh.exe'
  assert.equal(
    posixShell('win32', { PATH: 'C:\\tools', ProgramFiles: 'C:\\Program Files' }, has(git)),
    git,
  )
  assert.throws(
    () => posixShell('win32', { PATH: 'C:\\tools' }, () => false),
    /runs commands with a POSIX sh, and there's none on this machine\. Install Git for Windows/,
  )
})

test('the fake sandbox reads and writes ~/ paths in its home', async () => {
  const box = await createFakeSandbox({ kind: 'fake' })
  try {
    await box.writeFile('~/.config/reeval/hint.txt', 'from home')
    assert.equal(await box.readFile('~/.config/reeval/hint.txt'), 'from home')
    assert.equal(readFileSync(join(box.home, '.config/reeval/hint.txt'), 'utf8'), 'from home')
    assert.equal(await box.readFile('.config/reeval/hint.txt'), null, 'not in the workspace')
    assert.equal((await box.exec('cat ~/.config/reeval/hint.txt')).stdout, 'from home')
  } finally {
    await box.destroy()
  }
})

test('c.writeFile refuses absolute paths and paths that leave the workspace', async () => {
  const box = await createFakeSandbox({ kind: 'fake' })
  try {
    await snapshot(box)
    const a = {
      sandbox: box,
      signal: new AbortController().signal,
      start: async () => [box, {}],
    } as unknown as Attempt
    const { writeFile } = createChecks(a)
    for (const path of ['/etc/passwd', '../outside.txt', 'a/../../x', '~/../x', 'C:\\x', '.']) {
      await assert.rejects(writeFile(path, 'x'), {
        message: `c.writeFile() takes a workspace-relative path or ~/…, not ${JSON.stringify(path)}`,
      })
    }
    await writeFile('a/./placed.txt', 'kept')
    await writeFile('~/home.txt', 'home')
    assert.equal(await box.readFile('a/placed.txt'), 'kept')
    assert.equal(await box.readFile('~/home.txt'), 'home')
    assert.deepEqual((await diffSinceSnapshot(box)).files, [])
  } finally {
    await box.destroy()
  }
})

test("the snapshot keeps one commit and no placed file's earlier content", async () => {
  const box = await createFakeSandbox({ kind: 'fake' })
  try {
    await box.writeFile('src/sum.js', 'healthy\n')
    await box.writeFile('keep.txt', 'kept\n')
    await snapshot(box)
    await box.writeFile('src/sum.js', '')
    await acceptIntoSnapshot(box, 'src/sum.js')
    await box.writeFile('src/sum.js', 'bug\n')
    await acceptIntoSnapshot(box, 'src/sum.js')
    const git = `git --git-dir=${shellQuote(join(box.stateDir, 'workspace.git'))}`
    assert.equal((await box.exec(`${git} rev-list --all --count`)).stdout.trim(), '1')
    const objects = await box.exec(`${git} cat-file --batch-all-objects --batch`)
    assert.equal(objects.exitCode, 0)
    assert.match(objects.stdout, /bug\n/)
    assert.doesNotMatch(objects.stdout, /healthy/)
    assert.ok(
      !existsSync(join(box.workdir, '..', '.reeval-git-work')),
      'nothing beside the workspace',
    )
    await box.writeFile('src/sum.js', 'fixed\n')
    const diff = await diffSinceSnapshot(box)
    assert.deepEqual(diff.files, [{ path: 'src/sum.js', status: 'modified' }])
    assert.match(diff.patch, /^-bug\n\+fixed\n/m)
  } finally {
    await box.destroy()
  }
  assert.ok(!existsSync(box.stateDir), 'destroy removes the state directory')
})

test('changed paths come back as written, however git would quote them', async () => {
  const box = await createFakeSandbox({ kind: 'fake' })
  // Windows filenames can't hold a tab or `"`.
  const names = [
    'café.txt',
    'a b.txt',
    ...(process.platform === 'win32' ? [] : ['t\tab.txt', 'q"uote\\.txt']),
  ]
  try {
    await box.writeFile('keep.txt', 'kept\n')
    await snapshot(box)
    for (const name of names) await box.writeFile(name, 'new\n')
    await box.writeFile('keep.txt', 'changed\n')
    const diff = await diffSinceSnapshot(box)
    const expected = [
      ...names.map((path) => ({ path, status: 'added' })),
      { path: 'keep.txt', status: 'modified' },
    ]
    const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : 1)
    assert.deepEqual([...diff.files].sort(byPath), expected.sort(byPath))
    assert.deepEqual(
      splitPatch(diff.patch)
        .map((f) => [f.path, f.added, f.removed])
        .sort(),
      [...names.map((n) => [n, 1, 0]), ['keep.txt', 1, 1]].sort(),
    )
    const judged = judgeDiff(diff, { patterns: ['!café.txt', '!t*', '!q*'] })
    assert.doesNotMatch(
      judged.patch,
      /caf|t\tab|uote/,
      'a pattern drops a quoted path from the diff',
    )
    assert.match(judged.patch, /a b\.txt/)
  } finally {
    await box.destroy()
  }
})

test('the snapshot ignores a config the workspace user could plant in its HOME', async () => {
  const box = await createFakeSandbox({ kind: 'fake' })
  try {
    // A privileged git's HOME can be the agent's on a custom `from` image, so a `~/.gitconfig`
    // filter would run reeval's git as root. Prove the snapshot's git never reads it.
    const ran = join(box.stateDir, 'filter-ran')
    await box.writeFile('~/.gitconfig', `[filter "evil"]\n\tclean = touch ${ran}\n`)
    await box.writeFile('.gitattributes', 'secret.txt filter=evil\n')
    await box.writeFile('secret.txt', 'content\n')
    await snapshot(box)
    await box.writeFile('secret.txt', 'changed\n')
    await acceptIntoSnapshot(box, 'secret.txt')
    await diffSinceSnapshot(box)
    assert.ok(!existsSync(ran), 'the planted clean filter never ran')
  } finally {
    await box.destroy()
  }
})

test('an aborted fake sandbox command stops, with everything it started', async () => {
  const box = await createFakeSandbox({ kind: 'fake' })
  try {
    const abort = new AbortController()
    const started = Date.now()
    const running = box.exec('touch ~/started && sleep 30 && touch ~/finished', {
      signal: abort.signal,
    })
    while (!existsSync(join(box.home, 'started'))) await sleep(20)
    abort.abort(new Error('stop'))
    // It settles only once nothing holds its output pipes: the sleep is gone, not left to finish.
    await assert.rejects(running, /stop/)
    assert.ok(Date.now() - started < 20_000, `settled after ${Date.now() - started}ms`)
    assert.equal(existsSync(join(box.home, 'finished')), false)
  } finally {
    await box.destroy()
  }
})

test('destroying the fake sandbox removes it after a leftover host process', async () => {
  const box = await createFakeSandbox({ kind: 'fake' })
  const started = await box.exec(
    'node -e "setInterval(() => {}, 60000)" >/tmp/reeval-bg.log 2>&1 & echo $!',
  )
  const pid = started.stdout.trim().split(/\s+/).at(-1) ?? ''
  assert.match(pid, /^\d+$/)
  await sleep(100)
  await box.destroy()
  assert.equal(existsSync(box.home), false, 'the sandbox directory is gone')
})

test('destroying an already-removed fake sandbox is a no-op', async () => {
  const box = await createFakeSandbox({ kind: 'fake' })
  await box.destroy()
  assert.equal(existsSync(box.home), false)
  await box.destroy()
  assert.equal(existsSync(box.home), false)
})

test("the fake agent's MCP step waits for a slow server's reply, and reports a crash", async () => {
  const box = await createFakeSandbox({ kind: 'fake' })
  // Event-driven, not timed: the server marks that the call arrived, then answers only once the
  // test opens the gate, and only if its stdin is still open (it exits when stdin closes, as SDK
  // stdio servers do). A client that stopped waiting gets no reply, however slow the machine is.
  await box.writeFile(
    '~/slow.mjs',
    `import { existsSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const home = process.env.HOME
let open = true
process.stdin.on('end', () => { open = false; process.exit(0) })
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line)
  if (m.method !== 'tools/call') return
  writeFileSync(home + '/called', '')
  const gate = setInterval(() => {
    if (!existsSync(home + '/gate')) return
    clearInterval(gate)
    if (!open) return
    const result = { content: [{ type: 'text', text: 'STAMP-7Q' }] }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n')
  }, 20)
})
`,
  )
  const call = async (args: string[]) => {
    const harness = createFakeHarness({
      kind: 'fake',
      script: [[{ mcp: 'stamp/house_stamp' }, { reply: 'done' }]],
    })
    const session = await harness.start(box, AbortSignal.timeout(60_000), {
      skills: [],
      workspaceSkills: [],
      plugins: [],
      mcp: { stamp: { transport: 'stdio', command: 'sh', args, env: {} } },
    })
    const turn = await session.send('stamp', AbortSignal.timeout(60_000))
    return turn.transcript.find((e) => e.type === 'tool')
  }
  /** Opens the gate once the call has reached the server, while the client is still waiting. */
  const openGate = async () => {
    for (let i = 0; i < 2400 && (await box.readFile('~/called')) === null; i++)
      await new Promise((r) => setTimeout(r, 25))
    assert.notEqual(await box.readFile('~/called'), null, 'the call never reached the server')
    await box.writeFile('~/gate', '')
  }
  try {
    const [slow] = await Promise.all([call(['-c', 'exec node "$HOME/slow.mjs"']), openGate()])
    assert.deepEqual(slow && [slow.tool, slow.output, slow.ok], [
      'mcp__stamp__house_stamp',
      'STAMP-7Q',
      true,
    ])
    const crashed = await call(['-c', 'echo boom >&2; exit 3'])
    assert.deepEqual(crashed && [crashed.output, crashed.ok], ['boom', false])
  } finally {
    await box.destroy()
  }
})

test('an auth failure names the credential; other errors get no hint', () => {
  // What each harness reported with a made-up key.
  const refused: Array<[AgentKind, string]> = [
    ['cursor', "Cursor's model catalog request failed: HTTP 401"],
    ['claude-code', 'Invalid API key · Fix external API key'],
    [
      'antigravity',
      'agent executor error: generating and executing: Error 400, Message: API key not valid. Please pass a valid API key., Status: INVALID_ARGUMENT',
    ],
    [
      'opencode',
      'ACP prompt update stream failed: Internal error: API key not valid. Please pass a valid API key.',
    ],
    [
      'goose',
      "Goose's model call failed: Request failed: Bad request (400): API key not valid. Please pass a valid API key.",
    ],
    [
      'pi',
      '{"error":{"code":400,"message":"API key not valid.","status":"INVALID_ARGUMENT","reason":"API_KEY_INVALID"}}',
    ],
    [
      'claude-code',
      '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    ],
    [
      'codex',
      'unexpected status 401 Unauthorized: Incorrect API key provided: sk-not-a*****-key. You can find your API key at https://platform.openai.com/account/api-keys., url: https://api.openai.com/v1/responses, auth error: 401, auth error code: invalid_api_key',
    ],
    [
      'grok-build',
      'ACP session initialization failed: ACP authentication method "xai.api_key" is not advertised by the agent. Advertised methods: grok.com.',
    ],
  ]
  for (const [kind, message] of refused) {
    const { credential } = AGENTS[kind]
    assert.equal(
      authHint(AGENTS[kind], message),
      `The API rejected ${credential}: set a valid key in the environment or .env.local`,
      message,
    )
  }
  // OpenCode's words for any provider refusing its key (Bedrock's 403), naming the
  // model's provider's variable.
  assert.equal(
    authHint(
      agentFor({ kind: 'opencode', model: 'amazon-bedrock/m' }),
      'ACP prompt update stream failed: Authentication required: provider authentication required',
    ),
    'The API rejected AWS_BEARER_TOKEN_BEDROCK: set a valid key in the environment or .env.local',
  )
  // fx's words, for a configured provider (OpenAI) and for AI Gateway.
  for (const [model, message, credential] of [
    ['gpt-4.1-mini', 'configured provider authentication failed · HTTP 401', 'OPENAI_API_KEY'],
    ['google/m', 'AI_GATEWAY_API_KEY authentication failed · HTTP 401', 'AI_GATEWAY_API_KEY'],
  ] as const) {
    assert.equal(
      authHint(agentFor({ kind: 'fx', model }), message),
      `The API rejected ${credential}: set a valid key in the environment or .env.local`,
      message,
    )
  }
  // The twins: a rate limit, a server error, a missing model and a refused host aren't the key.
  for (const message of [
    'HTTP 429: Resource has been exhausted (e.g. check quota).',
    'Request failed: 500 Internal Server Error',
    'models/gemini-9 is not found for API version v1beta (404)',
    'CONNECT blocked.example.net:443 → 403 · blocked',
    'The Antigravity CLI exited with code 1 before reporting a result',
    'ACP authentication method "grok.com" is not advertised by the agent',
  ]) {
    assert.equal(authHint(AGENTS.antigravity, message), undefined, message)
  }
})

test('parseDuration', () => {
  assert.equal(parseDuration('90s'), 90_000)
  assert.equal(parseDuration('15m'), 900_000)
  assert.equal(parseDuration(250), 250)
  assert.throws(() => parseDuration('soon' as never), /Invalid duration/)
  for (const value of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, '0s', '0m', '0.0h']) {
    assert.throws(
      () => parseDuration(value as never),
      /A duration is more than zero/,
      `parseDuration(${String(value)})`,
    )
  }
})

test('resolveConfig defaults', () => {
  const c = resolveConfig({}, '/p')
  assert.deepEqual(c.include, ['evals/**/*.eval.ts', 'evals/**/*.eval.py'])
  assert.deepEqual(c.harness, [{ kind: 'cursor', model: 'composer-2.5' }])
  assert.deepEqual(c.sandbox, { kind: 'docker' })
  assert.equal(c.environment, undefined, 'no environment by default')
  assert.deepEqual(c.profiles, {})
  assert.equal(c.runs, 1)
  assert.equal(c.judge.model, undefined, 'no default judge model')
  assert.equal(c.timeoutMs, 900_000)
})

test('concurrency: flag, then REEVAL_CONCURRENCY, then config, then a default sized to Docker', async () => {
  const GB = 1e9
  assert.equal(defaultConcurrency({ cpus: 20, memoryBytes: 8.2 * GB }), 8)
  assert.equal(defaultConcurrency({ cpus: 20, memoryBytes: 64 * GB }), 8)
  assert.equal(defaultConcurrency({ cpus: 4, memoryBytes: 16 * GB }), 4)
  assert.equal(defaultConcurrency({ cpus: 8, memoryBytes: 2 * GB }), 2)
  assert.equal(defaultConcurrency({ cpus: 8, memoryBytes: 0.5 * GB }), 1)
  const capacity = async () => ({ cpus: 3, memoryBytes: 64 * GB })
  const config = resolveConfig({}, '/p')
  assert.equal(await resolveConcurrency(config, undefined, capacity, {}), 3)
  const withConfig = resolveConfig({ concurrency: 5 }, '/p')
  assert.equal(await resolveConcurrency(withConfig, undefined, capacity, {}), 5)
  assert.equal(
    await resolveConcurrency(withConfig, undefined, capacity, { REEVAL_CONCURRENCY: '6' }),
    6,
  )
  assert.equal(await resolveConcurrency(withConfig, '7', capacity, { REEVAL_CONCURRENCY: '6' }), 7)
  await assert.rejects(resolveConcurrency(config, 'lots', capacity, {}), /--concurrency must be/)
  assert.throws(
    () => resolveConfig({ concurrency: 0 }, '/p'),
    /concurrency in reeval\.config\.ts must be a whole number of at least 1 \(got 0\)/,
  )
})

test('redactSecrets masks secret-looking env values', () => {
  const env = { MY_API_KEY: 'sk-live-1234567890', HOME: '/home/someone-long' }
  const text = JSON.stringify({ a: 'token sk-live-1234567890 here', home: '/home/someone-long' })
  const out = redactSecrets(text, env)
  assert.doesNotMatch(out, /sk-live/)
  assert.match(out, /\[REDACTED\]/)
  assert.match(out, /someone-long/)
})

test('judge prompt keeps source diffs and drops dependency noise', () => {
  const patch = [
    'diff --git a/node_modules/genkit/index.js b/node_modules/genkit/index.js',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/node_modules/genkit/index.js',
    '+module.exports = {}',
    'diff --git a/package-lock.json b/package-lock.json',
    '--- /dev/null',
    '+++ b/package-lock.json',
    '+{ "lock": true }',
    'diff --git a/src/index.js b/src/index.js',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/src/index.js',
    '+export const flow = () => ({ title: "Soup" })',
    '',
  ].join('\n')
  const shown = patchForJudge(patch)
  assert.match(shown, /src\/index\.js/)
  assert.match(shown, /title: "Soup"/)
  assert.doesNotMatch(shown, /module\.exports/)
  assert.doesNotMatch(shown, /"lock"/)
  assert.match(shown, /\[reeval: dropped node_modules\/ \(1 file\): installed dependencies\]/)
  assert.match(shown, /\[reeval: dropped package-lock\.json: lockfile, 1 changed line\]/)
  assert.equal(
    patchForJudge('diff --git a/greet.js b/greet.js\n+hi\n'),
    'diff --git a/greet.js b/greet.js\n+hi\n',
  )
})

test('judge model strings need a provider, and credentials follow the provider', () => {
  assert.match(checkModelString('gemini-3.8-flash') ?? '', /google\/gemini-3\.8-flash/)
  assert.equal(checkModelString('typesafe-ai/jev'), undefined)
  const gateway = ['AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN']
  assert.deepEqual(judgeCredentials('google/gemini-3.8-flash'), ['GOOGLE_GENERATIVE_AI_API_KEY'])
  assert.deepEqual(judgeCredentials('typesafe-ai/jev-1.14.0'), ['TYPESAFE_AI_API_KEY'])
  assert.deepEqual(judgeCredentials('anthropic/claude-x'), ['ANTHROPIC_API_KEY'])
  assert.deepEqual(judgeCredentials('openai/gpt-x'), ['OPENAI_API_KEY'])
  assert.deepEqual(judgeCredentials('mistral/large'), [], 'direct() has no route for mistral/*')
  assert.deepEqual(judgeCredentials('mistral/large', 'vercel'), gateway)
  assert.deepEqual(judgeCredentials('anthropic/claude-x', 'vercel'), gateway)
  assert.deepEqual(judgeCredentials({ kind: 'fake-judge', score: 1 }), [])
  assert.throws(
    () => resolveConfig({ judge: { model: 'gemini-3.8-flash' } }, '/p'),
    /provider prefix/,
  )
  assert.deepEqual(resolveConfig({}, '/p').judge, { threshold: 0.8 })
})

test('missingCredentials names the judge key for the configured provider', () => {
  const config = resolveConfig({ judge: { model: 'typesafe-ai/jev-1.14.0' } }, '/p')
  const jev = 'TYPESAFE_AI_API_KEY (for direct()) for the judge model, "typesafe-ai/jev-1.14.0"'
  assert.deepEqual(missingCredentials(config, { CURSOR_API_KEY: 'k' }), [jev])
  assert.deepEqual(
    missingCredentials(config, { CURSOR_API_KEY: 'k', AI_GATEWAY_API_KEY: 'g' }),
    [jev],
    'without vercel() in gateway, a Gateway key never stands in',
  )
  assert.deepEqual(
    missingCredentials(config, { CURSOR_API_KEY: 'k', TYPESAFE_AI_API_KEY: 't' }),
    [],
  )
  const onVercel = resolveConfig(
    { judge: { model: 'typesafe-ai/jev-1.14.0' }, gateway: [vercel()] },
    '/p',
  )
  assert.deepEqual(
    missingCredentials(onVercel, { CURSOR_API_KEY: 'k', AI_GATEWAY_API_KEY: 'g' }),
    [],
  )
  assert.deepEqual(
    missingCredentials(resolveConfig({}, '/p'), { CURSOR_API_KEY: 'k' }),
    [],
    'no judge, no key',
  )
})

test("the credential checks ask for the key of the judge the run uses, the profile's if it sets one", () => {
  const config = resolveConfig(
    {
      judge: { model: 'google/gemini-2.5-flash' },
      profiles: {
        fake: { judge: { model: fakeJudge() } },
        jev: { defaults: { judge: { model: 'typesafe-ai/jev-1.14.0' } } },
        threshold: { judge: { threshold: 0.5 } },
      },
    },
    '/p',
  )
  const env = { CURSOR_API_KEY: 'k' }
  const google =
    'GOOGLE_GENERATIVE_AI_API_KEY (for direct()) for the judge model, "google/gemini-2.5-flash"'
  const typesafe =
    'TYPESAFE_AI_API_KEY (for direct()) for the judge model, "typesafe-ai/jev-1.14.0"'
  const profile = (name: string) => selectProfile(config, name, {})
  assert.deepEqual(missingCredentials(config, env), [google])
  assert.deepEqual(
    missingCredentials(config, env, { profile: profile('fake') }),
    [],
    "a fake judge needs no key, whatever the config's judge is",
  )
  assert.deepEqual(missingCredentials(config, env, { profile: profile('jev') }), [typesafe])
  assert.deepEqual(
    missingCredentials(
      config,
      { ...env, GOOGLE_GENERATIVE_AI_API_KEY: 'g' },
      {
        profile: profile('jev'),
      },
    ),
    [typesafe],
    "the config judge's key doesn't stand in for the profile's",
  )
  assert.deepEqual(
    missingCredentials(config, env, { profile: profile('threshold') }),
    [google],
    'a profile judge without a model keeps the config judge',
  )

  const bad = { ...env, GOOGLE_GENERATIVE_AI_API_KEY: 'g g', TYPESAFE_AI_API_KEY: 't\nt' }
  assert.deepEqual(malformedCredentials(config, bad), [
    'GOOGLE_GENERATIVE_AI_API_KEY (character 2)',
  ])
  assert.deepEqual(malformedCredentials(config, bad, { profile: profile('fake') }), [])
  assert.deepEqual(malformedCredentials(config, bad, { profile: profile('jev') }), [
    'TYPESAFE_AI_API_KEY (character 2)',
  ])
})

test("the credential checks ask for the keys of the judges the plan's attempts resolve", () => {
  const config = resolveConfig({ judge: { model: 'google/gemini-2.5-flash' } }, '/p')
  const env = { CURSOR_API_KEY: 'k', GOOGLE_GENERATIVE_AI_API_KEY: 'g' }
  const judges = [
    { model: 'google/gemini-2.5-flash', gateway: 'direct' as const },
    { model: 'anthropic/claude-sonnet-5', gateway: 'direct' as const },
    { model: 'anthropic/claude-sonnet-5', gateway: 'vercel' as const },
  ]
  assert.deepEqual(missingCredentials(config, env, { judges }), [
    'ANTHROPIC_API_KEY (for direct()) for the judge model, "anthropic/claude-sonnet-5"',
    'AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN (for vercel()) for the judge model, "anthropic/claude-sonnet-5"',
  ])
  assert.deepEqual(
    missingCredentials(
      config,
      { ...env, ANTHROPIC_API_KEY: 'a', AI_GATEWAY_API_KEY: 'v' },
      { judges },
    ),
    [],
  )
  assert.deepEqual(
    malformedCredentials(
      config,
      { ...env, ANTHROPIC_API_KEY: 'a\nb', AI_GATEWAY_API_KEY: ' v' },
      {
        judges,
      },
    ),
    ['ANTHROPIC_API_KEY (character 2)', 'AI_GATEWAY_API_KEY (character 1)'],
  )
})

test('judge strings use the provider package on direct, and the AI Gateway only on vercel', () => {
  const jev = 'typesafe-ai/jev-1.14.0'
  assert.deepEqual(judgeRoute(jev, { TYPESAFE_AI_API_KEY: 't', AI_GATEWAY_API_KEY: 'g' }), {
    kind: 'direct',
    provider: 'typesafe-ai',
    pkg: '@ai-sdk/typesafe-ai',
  })
  assert.deepEqual(judgeRoute(jev, { AI_GATEWAY_API_KEY: 'g' }, 'judge model', 'vercel'), {
    kind: 'gateway',
  })
  assert.equal(
    judgeRoute('google/gemini-3.8-flash', { GOOGLE_GENERATIVE_AI_API_KEY: 'k' }).kind,
    'direct',
  )
  assert.deepEqual(
    judgeRoute('mistral/large', { VERCEL_OIDC_TOKEN: 'o' }, 'judge model', 'vercel'),
    { kind: 'gateway' },
  )
  assert.throws(
    () => judgeRoute(jev, {}),
    /^Error: No credentials for judge model "typesafe-ai\/jev-1\.14\.0" \(provider "typesafe-ai"\)\. Set TYPESAFE_AI_API_KEY \(for direct\(\)\), in the environment or \.env\.local\.$/,
  )
  assert.throws(
    () => judgeRoute(jev, { AI_GATEWAY_API_KEY: 'g' }),
    /^Error: No credentials for judge model "typesafe-ai\/jev-1\.14\.0" \(provider "typesafe-ai"\)\. Set TYPESAFE_AI_API_KEY \(for direct\(\)\), in the environment or \.env\.local\. AI_GATEWAY_API_KEY is set, but no gateway in the config uses it: add vercel\(\) to gateway to call the model through Vercel AI Gateway\.$/,
    'a Gateway key that would have worked says how to use it',
  )
  assert.throws(
    () => judgeRoute(jev, {}, 'judge model', 'vercel'),
    /Set AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN \(for vercel\(\)\), in the environment or \.env\.local\.$/,
  )
})

describe('each provider prefix with each combination of keys', () => {
  const gateway = { kind: 'gateway' }
  const direct = (provider: string, pkg: string) => ({ kind: 'direct', provider, pkg })
  const providers: Array<[string, string, string]> = [
    ['anthropic/claude-sonnet-5', 'anthropic', 'ANTHROPIC_API_KEY'],
    ['openai/gpt-6-luna', 'openai', 'OPENAI_API_KEY'],
    ['google/gemini-3.8-flash', 'google', 'GOOGLE_GENERATIVE_AI_API_KEY'],
    ['typesafe-ai/jev-1.14.0', 'typesafe-ai', 'TYPESAFE_AI_API_KEY'],
  ]
  const messageOf = (run: () => unknown) => {
    try {
      run()
    } catch (error) {
      return (error as Error).message
    }
    return undefined
  }
  for (const [model, provider, key] of providers) {
    test(model, () => {
      const pkg = `@ai-sdk/${provider}`
      assert.deepEqual(judgeRoute(model, { [key]: 'k' }), direct(provider, pkg), 'direct key')
      assert.deepEqual(
        judgeRoute(model, { [key]: 'k', AI_GATEWAY_API_KEY: 'g' }),
        direct(provider, pkg),
        'direct ignores the Gateway key',
      )
      for (const env of [{ AI_GATEWAY_API_KEY: 'g' }, { VERCEL_OIDC_TOKEN: 'o' }]) {
        assert.throws(() => judgeRoute(model, env), /add vercel\(\) to gateway/)
        assert.deepEqual(judgeRoute(model, env, 'judge model', 'vercel'), gateway)
      }
      assert.deepEqual(
        judgeRoute(model, { [key]: 'k', AI_GATEWAY_API_KEY: 'g' }, 'judge model', 'vercel'),
        gateway,
        "vercel ignores the provider's own key",
      )
      const none = messageOf(() => judgeRoute(model, {}))
      assert.equal(
        none,
        `No credentials for judge model "${model}" (provider "${provider}"). Set ${key} (for direct()), in the environment or .env.local.`,
      )
      assert.throws(
        () => judgeRoute(model, { [key]: 'sk-ant\nrest' }),
        new RegExp(
          `^Error: ${key} for judge model "${model.replaceAll('.', '\\.')}" has whitespace or a line break in it at character 7\\.`,
        ),
      )
      assert.throws(
        () => judgeRoute(model, { AI_GATEWAY_API_KEY: 'g g' }, 'judge model', 'vercel'),
        /AI_GATEWAY_API_KEY for judge model .* at character 2/,
      )
    })
  }
  test('analysis.model names the keys for its prefix, briefly for the closing line', async () => {
    const { analysisKeyProblem } = await import('../src/analysis/model.ts')
    const config = (model: string, gateways?: GatewayDescriptor[]) =>
      resolveConfig({ analysis: { model }, ...(gateways ? { gateway: gateways } : {}) }, '/p')
    const anthropic = config('anthropic/claude-sonnet-5')
    assert.equal(analysisKeyProblem(anthropic, { ANTHROPIC_API_KEY: 'a' }), null)
    assert.equal(
      analysisKeyProblem(anthropic, {}),
      'set ANTHROPIC_API_KEY (for direct()) for analysis.model, "anthropic/claude-sonnet-5", in .env.local, or analysis: { insights: false }',
    )
    assert.equal(
      analysisKeyProblem(anthropic, { AI_GATEWAY_API_KEY: 'g' }),
      'set ANTHROPIC_API_KEY (for direct()) for analysis.model, "anthropic/claude-sonnet-5", in .env.local, or analysis: { insights: false }. AI_GATEWAY_API_KEY is set, but no gateway in the config uses it: add vercel() to gateway to call the model through Vercel AI Gateway.',
    )
    assert.equal(
      analysisKeyProblem(config('anthropic/claude-sonnet-5', [vercel()]), {
        AI_GATEWAY_API_KEY: 'g',
      }),
      null,
    )
    assert.equal(
      analysisKeyProblem(config('openai/gpt-6-luna'), {}, true),
      'set OPENAI_API_KEY, or analysis: { insights: false }',
    )
    assert.equal(
      analysisKeyProblem(config('mistral/large'), { AI_GATEWAY_API_KEY: 'g' }),
      'analysis.model "mistral/large": no gateway in the list can serve it (direct: reeval calls only anthropic/*, google/*, openai/*, typesafe-ai/* models on their own keys). Add vercel() to gateway. Or analysis: { insights: false }.',
    )
    assert.match(
      analysisKeyProblem(anthropic, { ANTHROPIC_API_KEY: 'a\nb' }) ?? '',
      /^ANTHROPIC_API_KEY for analysis model "anthropic\/claude-sonnet-5" has whitespace or a line break in it at character 2\./,
    )
  })

  test('any other prefix needs vercel()', () => {
    for (const env of [{}, { AI_GATEWAY_API_KEY: 'g' }]) {
      assert.throws(
        () => judgeRoute('mistral/large', env),
        /needs vercel\(\) in the config's gateway list/,
      )
    }
    assert.deepEqual(
      judgeRoute('mistral/large', { AI_GATEWAY_API_KEY: 'g' }, 'judge model', 'vercel'),
      gateway,
    )
  })
})

test('huge single outputs keep their head and tail, with a marker and hash', () => {
  const big = `${'a'.repeat(100_000)}${'m'.repeat(100_000)}${'z'.repeat(20_000)}`
  const capped = capText(big)
  assert.ok(capped.length < OUTPUT_CAP + 200)
  assert.ok(capped.startsWith('a'.repeat(1000)))
  assert.ok(capped.endsWith('z'.repeat(1000)))
  assert.match(capped, /\[reeval: truncated \d+ of 220000 characters, sha256 [0-9a-f]{64}\]/)
  assert.equal(capText('small'), 'small')
})

test('findConfig takes the nearest config at or above the directory, like Vitest and ESLint', () => {
  const root = mkdtempSync(join(tmpdir(), 'reeval-find-config-'))
  try {
    const deep = join(root, 'app', 'src', 'lib')
    mkdirSync(deep, { recursive: true })
    assert.equal(findConfig(deep), undefined, 'no config up to the filesystem root')
    writeFileSync(join(root, 'reeval.config.mjs'), '')
    assert.equal(findConfig(deep), join(root, 'reeval.config.mjs'), 'any supported extension')
    writeFileSync(join(root, 'reeval.config.ts'), '')
    assert.equal(findConfig(deep), join(root, 'reeval.config.ts'), '.ts first in one directory')
    writeFileSync(join(root, 'app', 'reeval.config.cjs'), '')
    assert.equal(findConfig(deep), join(root, 'app', 'reeval.config.cjs'), 'the nearest wins')
    assert.equal(findConfig(root), join(root, 'reeval.config.ts'), 'never looks below')
    writeFileSync(join(root, 'app', 'reeval.claude.config.ts'), '')
    assert.equal(findConfig(join(root, 'app')), join(root, 'app', 'reeval.config.cjs'))
    assert.deepEqual(CONFIG_FILES, [
      'reeval.config.ts',
      'reeval.config.mts',
      'reeval.config.cts',
      'reeval.config.js',
      'reeval.config.mjs',
      'reeval.config.cjs',
      'reeval.yaml',
      'reeval.yml',
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('findConfig takes a reeval.yaml, and refuses it beside another config', () => {
  const root = mkdtempSync(join(tmpdir(), 'reeval-yaml-'))
  try {
    mkdirSync(join(root, 'app'))
    writeFileSync(join(root, 'reeval.yml'), '')
    assert.equal(findConfig(join(root, 'app')), join(root, 'reeval.yml'), '.yml too')
    writeFileSync(join(root, 'app', 'reeval.yaml'), '')
    assert.equal(
      findConfig(join(root, 'app')),
      join(root, 'app', 'reeval.yaml'),
      'the nearest wins',
    )
    writeFileSync(join(root, 'app', 'reeval.config.ts'), '')
    assert.throws(
      () => findConfig(join(root, 'app')),
      (e: unknown) =>
        e instanceof UsageError &&
        /^reeval\.config\.ts and reeval\.yaml are both in .*app: reeval reads one config per directory\. Keep one, or pass --config\.$/.test(
          e.message,
        ),
    )
    writeFileSync(join(root, 'reeval.yaml'), '')
    assert.throws(() => findConfig(root), /^UsageError: reeval\.yaml and reeval\.yml are both in /)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a reeval.yaml's relative host paths resolve against its directory", async () => {
  const root = mkdtempSync(join(tmpdir(), 'reeval-yaml-paths-'))
  const dir = join(root, 'project')
  try {
    mkdirSync(join(dir, 'docker'), { recursive: true })
    writeFileSync(join(dir, 'docker', 'Dockerfile'), 'FROM debian:bookworm-slim\n')
    const absolute = join(root, 'elsewhere.md')
    writeFileSync(
      join(dir, 'reeval.yaml'),
      `sandbox: { kind: docker, dockerfile: docker/Dockerfile }
environment:
  kind: environment
  name: base
  layers:
    - name: base
      spec:
        workspace: { kind: git, repo: ../app, url: ../app }
        files:
          a.md: { kind: file, path: notes/a.md }
          b.md: { kind: file, path: ${JSON.stringify(absolute)} }
          c.md: written inline
        rules: { kind: file, path: ./AGENTS.md }
        skills:
          - { kind: skill, source: local, path: ./skills, placement: harness }
          - { kind: skill, source: npm, spec: file:../pkg.tgz, path: skills, placement: harness }
          - { kind: skill, source: npm, spec: '@acme/skills@1.2.3', path: skills, placement: harness }
profiles:
  local:
    defaults:
      sandbox: { kind: fake, dir: ./tmp }
      environment:
        kind: environment
        name: remote
        layers: [{ name: remote, spec: { workspace: { kind: git, repo: github:acme/app, url: https://github.com/acme/app.git } } }]
`,
    )
    const config = await loadConfig(join(dir, 'reeval.yaml'))
    assert.deepEqual(config.sandbox, { kind: 'docker', dockerfile: join(dir, 'docker/Dockerfile') })
    const spec = config.environment?.layers[0]?.spec
    assert.equal(spec?.workspace?.url, join(root, 'app'))
    assert.equal(spec?.workspace?.repo, '../app', 'repo stays as written')
    assert.deepEqual(spec?.files, {
      'a.md': { kind: 'file', path: join(dir, 'notes/a.md') },
      'b.md': { kind: 'file', path: absolute },
      'c.md': 'written inline',
    })
    assert.deepEqual(spec?.rules, { kind: 'file', path: join(dir, 'AGENTS.md') })
    assert.deepEqual(
      spec?.skills?.map((s) => (s.source === 'local' ? s.path : s.source === 'npm' ? s.spec : '')),
      [join(dir, 'skills'), join(root, 'pkg.tgz'), '@acme/skills@1.2.3'],
    )
    const local = config.profiles.local?.defaults
    assert.deepEqual(local?.sandbox, { kind: 'fake', dir: join(dir, 'tmp') })
    const remote = local?.environment?.layers[0]?.spec.workspace
    assert.equal(remote?.url, 'https://github.com/acme/app.git', 'a URL is not a path')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a relative host path resolves the same in reeval.yaml, TypeScript data and the helpers', async () => {
  const dockerfile = 'FROM debian:bookworm-slim\n'
  const p = await project('path-parity', {
    'yaml/docker/Dockerfile': dockerfile,
    'data/docker/Dockerfile': dockerfile,
    'helpers/docker/Dockerfile': dockerfile,
    'yaml/reeval.yaml': `sandbox: { kind: docker, dockerfile: docker/Dockerfile }
environment:
  kind: environment
  name: base
  layers:
    - name: base
      spec:
        workspace: { kind: git, repo: ../app, url: ../app }
        files: { a.md: { kind: file, path: notes/a.md }, b.md: inline }
        rules: { kind: file, path: ./AGENTS.md }
        skills:
          - { kind: skill, source: local, path: ./skills, placement: harness }
          - { kind: skill, source: npm, spec: file:../pkg.tgz, path: skills, placement: harness }
profiles:
  local: { defaults: { sandbox: { kind: fake, dir: ./tmp } } }
`,
    'data/reeval.config.ts': `import { defineConfig, defineEnvironment } from 'reeval'
export default defineConfig({
  sandbox: { kind: 'docker', dockerfile: 'docker/Dockerfile' },
  environment: defineEnvironment('base', {
    workspace: { kind: 'git', repo: '../app', url: '../app' },
    files: { 'a.md': { kind: 'file', path: 'notes/a.md' }, 'b.md': 'inline' },
    rules: { kind: 'file', path: './AGENTS.md' },
    skills: [
      { kind: 'skill', source: 'local', path: './skills', placement: 'harness' },
      { kind: 'skill', source: 'npm', spec: 'file:../pkg.tgz', path: 'skills', placement: 'harness' },
    ],
  }),
  profiles: { local: { defaults: { sandbox: { kind: 'fake', dir: './tmp' } } } },
})
`,
    'helpers/reeval.config.ts': `import { defineConfig, defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'
export default defineConfig({
  sandbox: docker({ dockerfile: 'docker/Dockerfile' }),
  environment: defineEnvironment('base', ({ file, git, skill }) => ({
    workspace: git('../app'),
    files: { 'a.md': file('notes/a.md'), 'b.md': 'inline' },
    rules: file('./AGENTS.md'),
    skills: [skill.local('./skills'), skill.npm('file:../pkg.tgz')],
  })),
  profiles: { local: { defaults: { sandbox: fakeSandbox({ dir: './tmp' }) } } },
})
`,
  })
  const resolved = async (name: string, config: string) => {
    const dir = join(p.dir, name)
    const c = await loadConfig(join(dir, config))
    const paths = {
      sandbox: c.sandbox,
      spec: c.environment?.layers[0]?.spec,
      local: c.profiles.local?.defaults.sandbox,
    }
    return JSON.parse(JSON.stringify(paths).replaceAll(JSON.stringify(dir).slice(1, -1), '<dir>'))
  }
  const yaml = await resolved('yaml', 'reeval.yaml')
  assert.deepEqual(yaml.sandbox, { kind: 'docker', dockerfile: join('<dir>', 'docker/Dockerfile') })
  assert.deepEqual(yaml.local, { kind: 'fake', dir: join('<dir>', 'tmp') })
  assert.equal(yaml.spec.workspace.url, join(p.dir, 'app'))
  assert.deepEqual(await resolved('data', 'reeval.config.ts'), yaml, 'TypeScript data')
  assert.deepEqual(await resolved('helpers', 'reeval.config.ts'), yaml, 'the helpers')
})

test('fakeSandbox resolves a relative dir against the file that calls it', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  assert.equal(fakeSandbox({ dir: './sandboxes' }).dir, join(here, 'sandboxes'))
  assert.equal(fakeSandbox({ dir: '/abs/sandboxes' }).dir, '/abs/sandboxes')
  assert.equal(fakeSandbox().dir, undefined)
})

test('requireConfig refuses a missing file with the config names doctor lists and reeval init', () => {
  const found = '/tmp/reeval.config.ts'
  assert.equal(requireConfig(found), found)
  assert.throws(
    () => requireConfig(undefined),
    (e: unknown) => e instanceof UsageError && e.message === missingConfigMessage(),
  )
  assert.equal(
    missingConfigMessage(),
    'No reeval.config.ts (or reeval.config.mts, reeval.config.cts, reeval.config.js, reeval.config.mjs, reeval.config.cjs, reeval.yaml, reeval.yml) here or above. Run reeval init.',
  )
})

test('the history folder sits in the directory the evals live in', () => {
  assert.equal(evalRoot(['evals/**/*.eval.ts']), 'evals')
  assert.equal(evalRoot(['test/evals/a/*.eval.ts', 'test/evals/b/**/*.eval.ts']), 'test/evals')
  assert.equal(evalRoot(['**/*.eval.ts']), '')
  assert.equal(resolveConfig({}, '/p').history.dir, resolve('/p/evals/.history'))
  assert.equal(resolveConfig({ history: { dir: 'runs' } }, '/p').history.dir, resolve('/p/runs'))
  assert.equal(resolveConfig({}, '/p').record, 'ci')
  assert.throws(() => resolveConfig({ history: { artifacts: 'some' as 'all' } }, '/p'), /artifacts/)
})

test('an npm install in the sandbox collapses to one line for the judge', () => {
  const deps = Array.from({ length: 10_000 }, (_, i) => `node_modules/pkg${i}/index.js`)
  const patch = [
    ...deps.map((p) => `diff --git a/${p} b/${p}\nnew file mode 100644\n+x\n`),
    'diff --git a/src/app.js b/src/app.js\n+app\n',
  ].join('')
  const shown = patchForJudge(patch)
  assert.ok(shown.length < 500, `judge diff is ${shown.length} characters`)
  assert.match(shown, /\[reeval: dropped node_modules\/ \(10000 files\)/)
  assert.equal(shown.match(/\[reeval: dropped/g)?.length, 1, 'one marker for the whole directory')
  assert.match(shown, /\+app/)
  const files = changedFilesForJudge([
    ...deps.map((path) => ({ path, status: 'added' })),
    { path: 'src/app.js', status: 'added' },
  ])
  assert.deepEqual(files, ['added src/app.js', 'changed node_modules/ (10000 files)'])
})

const added = (path: string, ...lines: string[]) =>
  `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n${lines.map((l) => `+${l}\n`).join('')}`

test('the judge drops build output, source maps, build info and minified files, and says so', () => {
  const bundle = `var e=${'x'.repeat(2000)};`
  const paths = [
    'dist/assets/index-D1Ii1dIv.js',
    'dist/index.html',
    'packages/web/.next/server/page.js',
    'build/main.js',
    'out/index.html',
    'src/build/index.ts',
    'src/app.ts.map',
    'tsconfig.tsbuildinfo',
    'public/vendor.js',
    'src/app.ts',
  ]
  const patch = paths
    .map((p) => (p === 'public/vendor.js' ? added(p, bundle) : added(p, `// ${p}`)))
    .join('')
  const shown = judgeDiff({ patch, files: paths.map((path) => ({ path, status: 'added' })) })
  assert.deepEqual(shown.dropped, [
    'dist/ (2 files): build output',
    'packages/web/.next/ (1 file): build output',
    'build/ (1 file): build output',
    'out/ (1 file): build output',
    'src/app.ts.map: generated',
    'tsconfig.tsbuildinfo: generated',
    'public/vendor.js: minified, a line of 2007 characters',
  ])
  for (const what of shown.dropped) assert.ok(shown.patch.includes(`[reeval: dropped ${what}]`))
  assert.match(shown.patch, /\+\/\/ src\/app\.ts\n/)
  assert.match(shown.patch, /\+\/\/ src\/build\/index\.ts/, 'a nested build/ can be source')
  assert.doesNotMatch(shown.patch, /x{1000}/)
  assert.deepEqual(shown.files, [
    'added src/build/index.ts',
    'added src/app.ts.map',
    'added tsconfig.tsbuildinfo',
    'added public/vendor.js',
    'added src/app.ts',
    'changed dist/ (2 files)',
    'changed packages/web/.next/ (1 file)',
    'changed build/ (1 file)',
    'changed out/ (1 file)',
  ])
})

test("the judge's state.diff patterns filter its diff and files, the last match winning; contents leave the diff", () => {
  const paths = ['src/app.ts', 'src/app.test.ts', 'src/secret/key.ts', 'README.md', 'dist/a.js']
  const diff = {
    patch: paths.map((p) => added(p, `// ${p}`)).join(''),
    files: paths.map((path) => ({ path, status: 'added' })),
  }
  const only = judgeDiff(diff, { patterns: ['src/', '!*.test.ts', '!src/secret/', 'src/secret/'] })
  assert.deepEqual(only.files, ['added src/app.ts', 'added src/secret/key.ts'])
  assert.match(only.patch, /src\/app\.ts/)
  assert.match(only.patch, /src\/secret\/key\.ts/, 'a later pattern includes it again')
  assert.doesNotMatch(
    only.patch,
    /README|app\.test|dist\//,
    'nothing outside the patterns, not even a marker',
  )
  assert.deepEqual(only.dropped, [
    'src/app.test.ts: not in state.diff',
    'README.md: not in state.diff',
    'dist/a.js: not in state.diff',
  ])
  const without = judgeDiff(diff, { patterns: ['!README.md'] })
  assert.deepEqual(without.files, [
    'added src/app.ts',
    'added src/app.test.ts',
    'added src/secret/key.ts',
    'changed dist/ (1 file)',
  ])
  const inFull = judgeDiff(diff, { inFull: new Set(['src/app.ts']) })
  assert.doesNotMatch(inFull.patch, /\/\/ src\/app\.ts\n/, 'shown in full, so not in the diff')
  assert.match(inFull.patch, /\/\/ src\/app\.test\.ts/)
  assert.ok(inFull.files.includes('added src/app.ts'), 'still listed as changed')
})

test('a judge model its route answers only with a decision model fails in a sentence of its own', async () => {
  const realFetch = globalThis.fetch
  const keys = { OPENAI_API_KEY: 'sk-test', AI_GATEWAY_API_KEY: 'vck-test' }
  const realKeys = Object.fromEntries(Object.keys(keys).map((k) => [k, process.env[k]]))
  const refused = (status: number, message: string, code: string | null) =>
    Response.json(
      { error: { message, type: 'invalid_request_error', param: null, code } },
      { status },
    )
  globalThis.fetch = async (input) =>
    String(input).startsWith('https://api.openai.com/')
      ? refused(
          404,
          'The model `gpt-5.5` does not exist or you do not have access to it.',
          'model_not_found',
        )
      : refused(
          400,
          "Model 'anthropic/claude-sonnet-5' is a language model, not a decision model. Use the language generation API instead.",
          null,
        )
  Object.assign(process.env, keys)
  const score = (model: string, gateway: 'direct' | 'vercel') =>
    scoreWithModel(
      model,
      'q?',
      [{ type: 'text', text: 'x' }],
      undefined,
      new AbortController().signal,
      gateway,
    )
  try {
    await assert.rejects(score('openai/gpt-5.5', 'direct'), {
      message:
        "the judge model \"openai/gpt-5.5\" isn't a decision model: reeval's openai/* judges call OpenAI's Decisions API, which answers with 'gpt-6-luna' (OpenAI said: The model `gpt-5.5` does not exist or you do not have access to it.). Use 'openai/gpt-6-luna'.",
    })
    // gpt-6-luna is the decision model, so a refusal of it is the key's, in OpenAI's own words.
    await assert.rejects(score('openai/gpt-6-luna', 'direct'), {
      message: 'The model `gpt-5.5` does not exist or you do not have access to it.',
    })
    await assert.rejects(score('anthropic/claude-sonnet-5', 'vercel'), {
      message:
        "the judge model \"anthropic/claude-sonnet-5\" is a language model, and Vercel AI Gateway judges only with decision models. Use a decision model on vercel(), such as 'typesafe-ai/jev-1.14.0' or 'openai/gpt-6-luna-decisions', or pin this one to direct() with judge: { gateway: 'direct' } to call it on ANTHROPIC_API_KEY.",
    })
    await assert.rejects(score('mistral/large', 'vercel'), (error: Error) => {
      assert.match(error.message, /'openai\/gpt-6-luna-decisions'\.$/)
      assert.equal(isTransient(error), false, 'never retried')
      return true
    })
  } finally {
    globalThis.fetch = realFetch
    for (const [k, v] of Object.entries(realKeys)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})

test('TypeSafe Jev takes c.judge artifacts as a multipart image upload', async () => {
  const png = Buffer.from([137, 80, 78, 71])
  const resolved = resolveJudgeArtifacts(['form'], new Map([['form', png]]))
  const state = decideState({ task: 't', output: 'o' }, filePartsOf(resolved))
  const requests: Request[] = []
  const realFetch = globalThis.fetch
  const realKey = process.env.TYPESAFE_AI_API_KEY
  globalThis.fetch = async (input, init) => {
    requests.push(new Request(input, init))
    return Response.json({
      model: 'jev-1.14.0',
      answers: { answer: { type: 'noul', noul: 0.9 } },
    })
  }
  process.env.TYPESAFE_AI_API_KEY = 'ts-test'
  try {
    const { score, resolvedModel } = await scoreWithModel(
      'typesafe-ai/jev-1.14.0',
      'Does the form have a submit button?',
      state,
      undefined,
      new AbortController().signal,
    )
    assert.equal(score, 0.9)
    assert.equal(resolvedModel, 'jev-1.14.0')
  } finally {
    globalThis.fetch = realFetch
    if (realKey === undefined) delete process.env.TYPESAFE_AI_API_KEY
    else process.env.TYPESAFE_AI_API_KEY = realKey
  }
  assert.equal(requests.length, 1)
  const [request] = requests as [Request]
  assert.match(request.url, /\/systemone$/)
  assert.equal(request.headers.get('typesafe-danger-zone-images'), 'true')
  const form = await request.formData()
  const body = JSON.parse(await (form.get('request') as Blob).text())
  assert.equal(body.model, 'jev-1.14.0')
  const [[reference, asset]] = Object.entries(body.assets) as [[string, { part: string }]]
  assert.deepEqual(asset, { type: 'image', part: 'image-1' })
  assert.ok(body.state.includes(reference), 'the image is referenced where the capture sits')
  const image = form.get('image-1') as Blob
  assert.equal(image.type, 'image/png')
  assert.deepEqual(new Uint8Array(await image.arrayBuffer()), new Uint8Array(png))
})

test('decideState keeps JSON-only state an object', () => {
  const json = { task: 't', output: 'o' }
  assert.equal(decideState(json, []), json)
  const png = Buffer.from([137, 80, 78, 71])
  const resolved = resolveJudgeArtifacts(['form'], new Map([['form', png]]))
  const parts = decideState(json, filePartsOf(resolved))
  assert.ok(Array.isArray(parts))
  assert.deepEqual(parts[0], { type: 'json', value: json })
  assert.equal(parts[1]?.type, 'file')
  assert.equal((parts[1] as { mediaType: string }).mediaType, 'image/png')
  assert.deepEqual((parts[1] as { data: Uint8Array }).data, png)
  assert.match(badJudgeArtifacts('form') ?? '', /capture handles or names/)
  assert.equal(badJudgeArtifacts(['form']), undefined)
  assert.equal(
    badJudgeArtifacts([{ name: 'form', file: { path: 'artifacts/form.png' } }]),
    undefined,
  )
  assert.throws(
    () => resolveJudgeArtifacts(['missing'], new Map()),
    /artifacts names a capture this attempt doesn't have: "missing"/,
  )
})

test("a provider's error keeps its wording and adds what fills the judge's input", () => {
  const state = {
    task: 'Build a sign-in',
    output: 'Done.',
    files: ['added src/app.ts'],
    diff: added('src/huge.ts', 'x'.repeat(1_200_000)) + added('src/app.ts', 'y'.repeat(8_000)),
    contents: { 'README.md': 'z'.repeat(40_000) },
  }
  const message = withInputSize('{"error_type":"max_tokens_exceeded"}', state, 'Is it done?')
  assert.match(
    message,
    /^\{"error_type":"max_tokens_exceeded"\}\nThe judge's input was ~312k tokens \(estimated\): diff 302k, of which src\/huge\.ts is 300k, src\/app\.ts is 2k; contents 10k, of which README\.md is 10k\. Narrow /,
  )
  assert.match(
    message,
    /\. Narrow state\.diff, state\.contents, state\.files, state\.task or state\.output\.$/,
  )
  const small = withInputSize('Bad request', { task: 't', diff: '' }, 'q?')
  assert.match(
    small,
    /^Bad request\nThe judge's input was ~\d+ tokens \(estimated\): \w+ \d+\. Narrow /,
  )
  const apiError = Object.assign(new Error('Unprocessable'), { statusCode: 422 })
  assert.ok(isApiError(apiError))
  assert.ok(isApiError({ name: 'AI_RetryError', lastError: apiError }), 'through the SDK wrapper')
  assert.ok(!isApiError(new Error('Judge model "x" needs a provider prefix')))
})

const entry = (
  outcome: 'pass' | 'fail',
  stack: Partial<HistoryEntry['stack']> = {},
): HistoryEntry => ({
  runId: `20260924T10000${outcome === 'pass' ? 0 : 1}Z_abc1234_me`,
  recorded: true,
  status: 'complete',
  startedAt: '',
  author: 'me',
  git: null,
  runner: 'local',
  harnesses: ['cursor:composer-2.5'],
  summary: { evals: 1, attempts: 1, pass: 0, fail: 0, notGated: 0, infraError: 0, skipped: 0 },
  stack: {
    imageIds: ['sha256:aaa'],
    agentClis: ['1.0'],
    harnesses: ['cursor:composer-2.5'],
    environments: ['base@abc'],
    judgeModel: 'google/gemini-3.8-flash',
    judgeServed: ['gemini-3.8-flash-001'],
    judgeVersion: 'v1',
    threshold: 0.8,
    fingerprintScope: ['eval-source'],
    ...stack,
  },
  evals: [{ id: 'e', fingerprint: 'fp', outcome }],
})

test('compare classifies an eval on the cells both runs have, and lists the rest', () => {
  const cell = (
    key: string,
    outcome: 'pass' | 'fail',
    gate = 'all',
    fingerprint = `fp ${key}`,
  ) => ({
    key,
    gate,
    outcome,
    fingerprint,
    fingerprintParts: {},
  })
  const run = (outcome: 'pass' | 'fail', cells: ReturnType<typeof cell>[]): HistoryEntry => ({
    ...entry(outcome),
    evals: [
      {
        id: 'e',
        outcome,
        sources: [],
        fingerprint: cells.map((c) => c.fingerprint).join(),
        cells,
      } as unknown as HistoryEntry['evals'][number],
    ],
  })
  // The dogfood shape: base is the full run (✗, an Antigravity variant failed), head only re-ran
  // Antigravity's reeval-good cell.
  const base = run('fail', [
    cell('cursor/-', 'pass', 'none'),
    cell('cursor/reeval-good', 'pass'),
    cell('agy/-', 'fail', 'none'),
    cell('agy/reeval-weak', 'fail'),
    cell('agy/reeval-good', 'pass'),
  ])
  const removed = ['cursor/-', 'cursor/reeval-good', 'agy/-', 'agy/reeval-weak']
  const head = run('pass', [cell('agy/reeval-good', 'pass')])
  assert.deepEqual(compare(base, head), [
    { id: 'e', status: 'same', base: 'pass', head: 'pass', cells: { added: [], removed } },
  ])
  // The shared cell still decides: a flip in it is a regression, and a change in it is drift.
  const failed = run('fail', [cell('agy/reeval-good', 'fail')])
  assert.deepEqual(
    compare(base, failed).map((r) => [r.status, r.base, r.head]),
    [['regressed', 'pass', 'fail']],
  )
  const changed = run('pass', [cell('agy/reeval-good', 'pass', 'all', 'fp changed')])
  assert.equal(compare(base, changed)[0]?.status, 'drift')
  const disjoint = run('pass', [cell('other/-', 'pass')])
  assert.equal(compare(base, disjoint)[0]?.status, 'drift', 'no shared cell: not comparable')
})

test("compare names a gate change and classifies base's attempts under head's gate", () => {
  type Gate = HistoryEntry['evals'][number]['cells'][number]['gate']
  const PARTS = { sources: 's', harness: 'h', judge: 'j', context: 'c' }
  const cell = (
    gate: Gate,
    tally: { pass: number; fail: number },
    opts: { outcome?: Outcome; part?: boolean; harness?: string; cancelled?: number } = {},
  ) => {
    const required = gate === 'all' ? 1 : gate === 'none' ? 0 : gate.passRate
    const parts = {
      ...PARTS,
      harness: opts.harness ?? 'h',
      ...(opts.part === false ? {} : gatePart(gate)),
    }
    return {
      key: 'k',
      gate,
      ...tally,
      infraError: 0,
      skipped: 0,
      ...(opts.cancelled ? { cancelled: opts.cancelled } : {}),
      outcome:
        opts.outcome ?? (tally.pass / (tally.pass + tally.fail) >= required ? 'pass' : 'fail'),
      fingerprint: JSON.stringify(parts),
      fingerprintParts: parts,
    }
  }
  const run = (c: ReturnType<typeof cell>): HistoryEntry => ({
    ...entry(c.outcome === 'pass' ? 'pass' : 'fail'),
    evals: [
      {
        id: 'e',
        outcome: c.outcome,
        sources: [],
        fingerprint: c.fingerprint,
        cells: [c],
      } as unknown as HistoryEntry['evals'][number],
    ],
  })
  const row = (b: ReturnType<typeof cell>, h: ReturnType<typeof cell>) => {
    const r = compare(run(b), run(h))[0]
    return r && [r.status, r.base, r.head, r.gate?.rescored ?? null, r.changes ?? null]
  }
  const half = { pass: 1, fail: 1 }
  const loose = { passRate: 0.5 }

  assert.deepEqual(
    row(cell(loose, half), cell('all', half)),
    ['gate', 'pass', 'fail', 'fail', ['gate changed']],
    'tightened: base fails the new gate too',
  )
  assert.deepEqual(
    row(cell('all', half), cell(loose, half)),
    ['gate', 'fail', 'pass', 'pass', ['gate changed']],
    'loosened: base passes the new gate too',
  )
  assert.deepEqual(
    row(cell(loose, half), cell({ passRate: 0.3 }, { pass: 0, fail: 2 })),
    ['regressed', 'pass', 'fail', 'pass', ['gate changed']],
    'canary: base would still pass, so head failing is a regression',
  )
  assert.deepEqual(
    row(cell(loose, half), cell('all', { pass: 2, fail: 0 })),
    ['fixed', 'pass', 'pass', 'fail', ['gate changed']],
    'base would fail the stricter gate head passes: fixed',
  )
  assert.deepEqual(
    row(cell('all', { pass: 2, fail: 0 }, { outcome: 'fail' }), cell(loose, half)),
    ['fixed', 'fail', 'pass', 'fail', ['gate changed']],
    "a base that failed its minLift still fails it under head's gate",
  )
  assert.deepEqual(
    row(cell(loose, half, { part: false }), cell(loose, half)),
    ['same', 'pass', 'pass', null, null],
    'a record from before the gate was a part compares with one that has it',
  )
  assert.deepEqual(
    row(cell(loose, half, { part: false }), cell('all', half)),
    ['gate', 'pass', 'fail', 'fail', ['gate changed']],
    "and its gate is still read from the cell's",
  )
  assert.deepEqual(
    row(cell('all', half), cell({ passRate: 0.3 }, { pass: 0, fail: 2 })),
    ['regressed', 'fail', 'fail', 'pass', ['gate changed']],
    'both fail their own gates, but base would pass the looser one head fails',
  )
  assert.deepEqual(
    row(cell(loose, half, { cancelled: 1 }), cell('all', { pass: 2, fail: 0 })),
    ['same', 'pass', 'pass', 'pass', ['gate changed']],
    "a fail the interrupt cancelled isn't one under head's gate",
  )
  assert.deepEqual(
    row(cell({ passRate: 1 }, half), cell('all', half)),
    ['same', 'fail', 'fail', null, null],
    '`{ passRate: 1 }` is `all`',
  )
  assert.deepEqual(
    row(cell(loose, half), cell('all', half, { harness: 'h2' })),
    ['drift', 'pass', 'fail', null, ['harness config changed', 'gate changed']],
    'a gate change beside another part is drift, naming both',
  )
})

test("compare has a row for a pooled family's gate, comparable when its cases and variants are", () => {
  const FAMILY = 'evals/e.eval.ts › greets %s'
  type Lift = { variant: string; outcome: 'pass' | 'fail'; minLift?: number }
  const lift = (variant: string, outcome: 'pass' | 'fail', minLift: number | null = 0.2) => ({
    variant,
    outcome,
    ...(minLift === null ? {} : { minLift }),
  })
  const run = (
    lifts: Lift[],
    opts: { cases?: string[]; caseOutcome?: Outcome; cancelled?: number; fp?: string } = {},
  ): HistoryEntry => {
    const cases = opts.cases ?? ['ada', 'grace']
    return {
      ...entry('pass'),
      evals: cases.map(
        (name) =>
          ({
            id: `evals/e.eval.ts › greets ${name}`,
            outcome: opts.caseOutcome ?? 'pass',
            sources: [],
            fingerprint: opts.fp ?? 'fp',
            cells: [
              {
                key: 'k',
                gate: 'all',
                outcome: opts.caseOutcome ?? 'pass',
                fingerprint: opts.fp ?? 'fp',
                fingerprintParts: {},
                ...(opts.cancelled ? { cancelled: opts.cancelled } : {}),
              },
            ],
          }) as unknown as HistoryEntry['evals'][number],
      ),
      families: [
        {
          id: FAMILY,
          name: 'greets %s',
          cases: cases.length,
          ran: cases.length,
          outcome: lifts.some((l) => l.outcome === 'fail') ? 'fail' : 'pass',
          caseIds: cases.map((name) => `evals/e.eval.ts › greets ${name}`),
          lifts: lifts.map((l) => ({ vs: 'control', points: 0, lo: 0, hi: 0, ...l })),
        },
      ],
    }
  }
  const family = (base: HistoryEntry, head: HistoryEntry) =>
    compare(base, head).find((r) => r.kind === 'family')
  const status = (base: HistoryEntry, head: HistoryEntry) => {
    const r = family(base, head)
    return r && [r.status, r.base, r.head]
  }

  assert.deepEqual(status(run([lift('a', 'pass')]), run([lift('a', 'fail')])), [
    'regressed',
    'pass',
    'fail',
  ])
  assert.deepEqual(status(run([lift('a', 'fail')]), run([lift('a', 'pass')])), [
    'fixed',
    'fail',
    'pass',
  ])
  assert.equal(status(run([lift('a', 'pass')]), run([lift('a', 'pass')]))?.[0], 'same')
  assert.equal(
    family(run([lift('a', 'pass', null)]), run([lift('a', 'pass', null)])),
    undefined,
    'no minLift on either side: no row',
  )

  // Over the variants both have; with none in common, not comparable.
  const scoped = family(run([lift('a', 'pass'), lift('b', 'fail')]), run([lift('a', 'fail')]))
  assert.deepEqual(
    [scoped?.status, scoped?.base, scoped?.cells],
    ['regressed', 'pass', { added: [], removed: ['b'] }],
  )
  const disjoint = family(run([lift('a', 'pass')]), run([lift('b', 'fail')]))
  assert.deepEqual([disjoint?.status, disjoint?.cells], ['drift', { added: ['b'], removed: ['a'] }])

  // Its cases decide whether it's comparable.
  const fewer = family(run([lift('a', 'pass')]), run([lift('a', 'fail')], { cases: ['ada'] }))
  assert.deepEqual([fewer?.status, fewer?.changes], ['drift', ['case greets grace removed']])
  assert.equal(
    status(run([lift('a', 'pass')]), run([lift('a', 'fail')], { fp: 'changed' }))?.[0],
    'drift',
  )
  assert.equal(
    status(run([lift('a', 'pass')]), run([lift('a', 'fail')], { caseOutcome: 'infra_error' }))?.[0],
    'infra',
  )
  const cancelled = family(run([lift('a', 'pass')]), run([lift('a', 'fail')], { cancelled: 1 }))
  assert.deepEqual([cancelled?.status, cancelled?.cancelled], ['drift', ['head']])

  // An eval may share the family's id; the rows still tell them apart.
  const twin = (r: HistoryEntry): HistoryEntry => ({
    ...r,
    evals: [...r.evals, { ...(r.evals[0] as HistoryEntry['evals'][number]), id: FAMILY }],
  })
  const rows = compare(twin(run([lift('a', 'pass')])), twin(run([lift('a', 'fail')])))
  assert.deepEqual(
    rows.filter((r) => r.id === FAMILY).map((r) => [rowKey(r), r.status]),
    [
      [FAMILY, 'same'],
      [`family\0${FAMILY}`, 'regressed'],
    ],
  )
})

test('compare calls a flip drift when the judge changed outside the fingerprint', () => {
  assert.deepEqual(stackChanges(entry('pass'), entry('fail')), [])
  assert.equal(compare(entry('pass'), entry('fail'))[0]?.status, 'regressed')
  const served = entry('fail', { judgeServed: ['gemini-3.8-flash-002'] })
  assert.deepEqual(
    stackChanges(entry('pass'), served).map((c) => [c.label, c.base, c.head, c.outsideFingerprint]),
    [['judge model served', 'gemini-3.8-flash-001', 'gemini-3.8-flash-002', true]],
  )
  assert.equal(compare(entry('pass'), served)[0]?.status, 'drift')
  const cli = entry('fail', {
    agentClis: ['2.0'],
    imageIds: ['sha256:bbb'],
    environments: ['with-skill@def'],
  })
  assert.deepEqual(
    stackChanges(entry('pass'), cli).map((c) => c.label),
    ['image ids', 'agent CLI', 'environments'],
  )
  assert.equal(compare(entry('pass'), cli)[0]?.status, 'regressed', 'the fingerprint decides these')
  const unreported = entry('fail', { judgeServed: [] })
  assert.deepEqual(
    stackChanges(entry('pass'), unreported),
    [],
    'an unreported model is not a change',
  )
})

test('warnings only name states someone can act on', () => {
  const run = {
    git: { dirty: false, worktreePatch: null, worktreePatchNote: null },
    stack: { images: [{ ref: 'img:1', id: 'sha256:0123456789abcdef', repoDigests: [] }] },
  } as unknown as RunRecord
  assert.deepEqual(warnings(run), [
    "Image img:1 isn't pushed, so an exact rerun needs this machine's image (id 0123456789ab).",
  ])
  const pushed = {
    ...run,
    stack: { images: [{ ...run.stack.images[0], repoDigests: ['r@sha256:1'] }] },
  } as RunRecord
  assert.deepEqual(warnings(pushed), [])
  const dirty = {
    ...pushed,
    git: { dirty: true, worktreePatch: null, worktreePatchNote: 'too large to keep (9 bytes)' },
  } as unknown as RunRecord
  assert.match(warnings(dirty)[0] ?? '', /weren't saved \(too large to keep/)
})

/** An AI SDK evaluation model that fails with `errors` first, then answers `probability`. */
function scriptedModel(errors: Array<Record<string, unknown>>, probability = 0.9) {
  let calls = 0
  return {
    specificationVersion: 'v4',
    provider: 'mock',
    modelId: 'scripted',
    supportedQuestionTypes: ['boolean'],
    get calls() {
      return calls
    },
    async doEvaluate() {
      const error = errors[calls++]
      if (error) throw Object.assign(new Error(String(error.message)), error)
      return { answers: { answer: { type: 'boolean', probability } }, warnings: [] }
    },
  } as const
}

const quick = { attempts: 4, baseMs: 1, maxMs: 5 }
const judge = (model: object) =>
  runJudge('ok?', { output: 'x' }, { model, threshold: 0.8 }, new AbortController().signal, quick)

test('judge calls retry transient provider errors with backoff and record them', async () => {
  const model = scriptedModel([
    { message: 'The model is overloaded due to high demand', statusCode: 503 },
    { message: 'Too many requests', statusCode: 429, responseHeaders: { 'retry-after': '0' } },
  ])
  const { verdict, retries } = await judge(model)
  assert.equal(verdict.verdict, 'pass')
  assert.equal(model.calls, 3)
  assert.deepEqual(
    retries.map((r) => r.error),
    ['The model is overloaded due to high demand', 'Too many requests'],
  )
  for (const r of retries) assert.ok(r.delayMs >= 0 && r.delayMs <= quick.maxMs)
})

test('judge calls fail at once on permanent errors, and after the last try on transient ones', async () => {
  const bad = scriptedModel([{ message: 'API key not valid', statusCode: 401 }])
  await assert.rejects(judge(bad), (e: Error & { retries: unknown[] }) => {
    assert.equal(e.retries.length, 0)
    return /API key/.test(e.message)
  })
  assert.equal(bad.calls, 1)
  const down = scriptedModel(Array(10).fill({ message: 'Service Unavailable', statusCode: 503 }))
  await assert.rejects(judge(down), (e: Error & { retries: unknown[] }) => e.retries.length === 3)
  assert.equal(down.calls, quick.attempts)
})

test('isTimeout is the TimeoutError name, not the message', () => {
  assert.equal(isTimeout(new TimeoutError('Eval timed out after 1s')), true)
  assert.equal(isTimeout(new DOMException('Eval timed out after 1s', 'TimeoutError')), true)
  assert.equal(
    isTimeout(Object.assign(new Error('Eval timed out after 1s'), { name: 'TimeoutError' })),
    true,
  )
  assert.equal(isTimeout(new Error('Eval timed out after 1s')), false)
  assert.equal(isTimeout(new Error('setup step timed out after 1s')), false)
  assert.equal(isTimeout('timed out'), false)
  assert.equal(isTimeout(null), false)
})

test('transient judge errors and bounded backoff', () => {
  assert.equal(isTransient({ name: 'AI_APICallError', statusCode: 500, message: 'x' }), true)
  assert.equal(isTransient({ statusCode: 400, message: 'bad request' }), false)
  assert.equal(isTransient(new Error('fetch failed')), true)
  assert.equal(isTransient(new Error('ETIMEDOUT')), true)
  assert.equal(isTransient(new Error('No credentials for judge model')), false)
  assert.equal(isTransient(new TimeoutError('Eval timed out after 1s')), false)
  assert.equal(isTransient(new Error('request timed out')), false)
  assert.equal(isTransient({ name: 'AbortError', message: 'The run was cancelled' }), false)
  assert.equal(
    isTransient({ name: 'AI_RetryError', message: 'x', lastError: { statusCode: 503 } }),
    true,
  )
  const policy = { attempts: 6, baseMs: 2_000, maxMs: 30_000 }
  for (let retry = 0; retry < 8; retry++) {
    const ms = backoffMs(policy, retry, new Error('x'))
    assert.ok(ms <= 30_000 && ms >= Math.min(30_000, 2_000 * 2 ** retry) / 2, `${retry}: ${ms}`)
  }
  const later = { statusCode: 429, responseHeaders: { 'retry-after': '12' } }
  assert.ok(backoffMs(policy, 0, later) >= 12_000)
})

test('clip cuts on a word boundary with an ellipsis', () => {
  const question = `Does it follow ${'every numbered instruction, '.repeat(10)}exactly?`
  const cut = clip(question, 200)
  assert.ok(cut.length <= 200 && cut.endsWith('…'), cut)
  assert.match(cut, /(instruction,|numbered|every)…$/)
  assert.equal(clip('short', 200), 'short')
  assert.equal(clip('x'.repeat(300), 10), `${'x'.repeat(9)}…`)
})

const base: Resolved = {
  harness: [
    { kind: 'fake', id: 'a' },
    { kind: 'fake', id: 'b' },
  ],
  sandbox: { kind: 'fake' },
  environment: undefined,
  compare: undefined,
  runs: 3,
  env: {},
  egress: {},
  judge: {},
  capture: {},
  question: {},
  questions: [],
  timeout: undefined,
  tags: [],
  pin: [],
}

test('expand: per harness, the control then each variant; labels name the role', () => {
  const plain = defineEnvironment('plain', { files: { 'from-baseline.txt': 'base' } })
  const skill = defineEnvironment('skill', { env: { A: '1' } })
  const extra = defineEnvironment('extra', { files: { 'from-eval.txt': 'no' } })
  const { resolved } = cascade(
    base,
    [
      { options: { environment: extra }, where: 'group("parent")' },
      {
        options: { compare: { baseline: plain, variants: [skill] }, runs: 1 },
        where: 'e',
      },
    ],
    'e',
  )
  assert.equal(resolved.environment?.name, 'extra', 'the parent environment is still resolved')
  const attempts = expand(resolved)
  assert.deepEqual(
    attempts.map((a) => [a.cell.key, a.cell.role, a.gate !== 'none', a.label]),
    [
      ['a/plain/fake', 'control', false, 'a · control'],
      ['a/skill/fake', 'variant', true, 'a · skill'],
      ['b/plain/fake', 'control', false, 'b · control'],
      ['b/skill/fake', 'variant', true, 'b · skill'],
    ],
  )
  const variant = attempts.find((a) => a.cell.role === 'variant')
  assert.deepEqual(
    variant?.environment.layers.map((l) => l.name),
    ['skill'],
    'a variant is not layered on the baseline or the eval environment',
  )
  assert.equal(attempts[0]?.environment.layers[0]?.name, 'plain')
  assert.notEqual(attempts[0]?.environment.name, 'extra')
})

test('named compare uses the cascaded sandbox option, not the config environment', () => {
  const configEnv = defineEnvironment('config', {
    sandbox: { kind: 'fake', id: 'from-config-env' },
  })
  const plain = defineEnvironment('plain', {})
  const skill = defineEnvironment('skill', {})
  const parent = defineEnvironment('parent', { sandbox: { kind: 'fake', id: 'parent' } })
  const kept = parent.extend('kept', { files: { 'x.txt': 'y' } })
  const { resolved } = cascade(
    { ...base, sandbox: { kind: 'fake', id: 'from-root' }, environment: configEnv },
    [{ options: { compare: { baseline: plain, variants: [skill] }, runs: 1 }, where: 'e' }],
    'e',
  )
  assert.deepEqual(
    expand(resolved).map((a) => [a.cell.environment, a.sandbox.id]),
    [
      ['plain', 'from-root'],
      ['skill', 'from-root'],
      ['plain', 'from-root'],
      ['skill', 'from-root'],
    ],
  )
  const child = cascade(
    { ...base, sandbox: { kind: 'fake', id: 'from-root' } },
    [{ options: { environment: kept }, where: 'e' }],
    'e',
  )
  assert.equal(expand(child.resolved)[0]?.sandbox.id, 'parent')
  const evalSandbox = cascade(
    { ...base, sandbox: { kind: 'fake', id: 'from-root' } },
    [
      {
        options: { sandbox: { kind: 'fake', id: 'from-eval' }, environment: plain },
        where: 'e',
      },
    ],
    'e',
  )
  assert.equal(evalSandbox.resolved.sandbox.id, 'from-eval')
  assert.equal(expand(evalSandbox.resolved)[0]?.sandbox.id, 'from-eval')
})

test('environment beside a compare with a baseline is an error; without one it is the control', () => {
  const plain = defineEnvironment('plain', {})
  const skill = defineEnvironment('skill', {})
  assert.throws(
    () =>
      checkOptions(
        { environment: plain, compare: { baseline: plain, variants: [skill] } },
        'evaluate("e")',
      ),
    /environment and compare\.baseline can't both be set in evaluate\("e"\)/,
  )
  checkOptions({ environment: plain, compare: { variants: [skill] } }, 'evaluate("e")')
  assert.throws(
    () => checkOptions({ environment: plain, compare: false }, 'evaluate("e")'),
    /compare: false can't be set in evaluate\("e"\)/,
  )
  assert.throws(
    () => checkOptions({ compare: false }, 'group("g")'),
    /compare: false can't be set in group\("g"\)/,
  )
  checkOptions({ compare: { baseline: plain, variants: [skill] } }, 'evaluate("e")')
  checkOptions({ environment: plain }, 'evaluate("e")')
})

test('cascade: profile defaults sit under evals, limits narrow unless pinned, --runs wins', () => {
  const plain = defineEnvironment('plain', {})
  const skill = defineEnvironment('skill', {})
  const profile = {
    name: 'pr',
    reason: '--profile',
    defaults: { runs: 5 },
    limit: { runs: 1, compare: false as const, harness: ['a'] },
    judge: {},
    tags: [],
    budget: {},
  }
  const narrowed = cascade(
    base,
    [{ options: { compare: { baseline: plain, variants: [skill] } }, where: 'e' }],
    'e',
    { profile },
  )
  assert.equal(narrowed.resolved.runs, 1)
  assert.deepEqual(
    narrowed.resolved.harness.map((h) => h.id),
    ['a'],
  )
  assert.deepEqual(narrowed.resolved.compare?.variants, [])
  assert.deepEqual(narrowed.notes, [
    'runs 5 → 1 (profile pr)',
    'harnesses 2 → 1 (profile pr)',
    'compare off (profile pr)',
  ])
  const pinned = cascade(
    base,
    [
      {
        options: { compare: { baseline: plain, variants: [skill] }, pin: ['runs', 'compare'] },
        where: 'e',
      },
    ],
    'e',
    { profile, runs: 2 },
  )
  assert.equal(pinned.resolved.runs, 2, '--runs beats pins')
  assert.equal(pinned.resolved.compare?.variants.length, 1)
  const overridden = cascade(base, [{ options: {}, where: 'e' }], 'e', { profile, runs: 3 })
  assert.equal(overridden.resolved.runs, 3)
  assert.ok(
    !overridden.notes.some((n) => n.startsWith('runs ')),
    `--runs replaces the profile's limit, so no runs note: ${overridden.notes.join('; ')}`,
  )
  const skipped = cascade(
    base,
    [{ options: { harness: { kind: 'fake', id: 'c' } }, where: 'e' }],
    'e',
    { profile },
  )
  assert.equal(skipped.skip, 'no harness left: profile pr allows a')
})

test('a check a side never ran has no verdict, and not-run attempts are not failures', async () => {
  const { checkVerdict } = await import('../src/view/contrasts.ts')
  const t = (pass: number, fail: number, notRun = 0, error = 0) => ({ pass, fail, error, notRun })
  assert.equal(checkVerdict(t(0, 2), t(0, 0, 2)), undefined, 'failed against never ran')
  assert.equal(checkVerdict(t(2, 0), t(0, 0, 2)), undefined, 'passed against never ran')
  assert.equal(checkVerdict(t(2, 0, 1), t(2, 0)), 'both-pass', 'a not-run attempt is no fail')
  assert.equal(checkVerdict(t(0, 1, 1), t(2, 0)), 'discriminates')
  assert.equal(checkVerdict(t(1, 1), t(0, 0, 2)), undefined)
  assert.equal(checkVerdict(t(2, 0), t(0, 2)), 'discriminates')
  assert.equal(checkVerdict(t(2, 0), t(0, 0, 0, 2)), undefined, 'ran but never answered')
})

test('effort under 10s reads in tenths, so a ratio matches its times', async () => {
  const { formatSeconds } = await import('../src/view/effort.ts')
  assert.deepEqual([0, 40, 49, 50, 200, 400, 1500, 9949, 9950, 46_000, 90_000].map(formatSeconds), [
    '<0.1s',
    '<0.1s',
    '<0.1s',
    '0.1s',
    '0.2s',
    '0.4s',
    '1.5s',
    '9.9s',
    '10s',
    '46s',
    '1m 30s',
  ])
})

test('extendEnvironment layers and overrides; a separate environment does not', async () => {
  const main = defineEnvironment('main', ({ secret }) => ({
    sandbox: { kind: 'fake', id: 'parent' },
    env: { KEY: secret.fromEnv('REEVAL_UNIT_KEY', { optional: true }), MODE: 'main' },
    files: { 'a.txt': 'main' },
    setup: ['echo one'],
  }))
  const branch = main.extendEnvironment('branch', {
    sandbox: { kind: 'fake', id: 'child' },
    env: { MODE: 'branch' },
    setup: ['echo two'],
  })
  const other = defineEnvironment('other', { files: { 'a.txt': 'other' }, rules: 'Be terse.' })
  const child = applied(branch)
  assert.deepEqual(
    child.layers.map((l) => l.name),
    ['main', 'branch'],
    'extendEnvironment keeps the parent layers',
  )
  const r = await resolveEnvironment(child, {}, '/p', 'e', 'AGENTS.md')
  assert.deepEqual(r.record.overrides, ['sandbox', 'env.MODE'])
  assert.equal(child.layers.at(-1)?.spec.sandbox?.id, 'child')
  assert.equal(main.layers[0]?.spec.sandbox?.id, 'parent')
  assert.deepEqual(r.record.setup, ['echo one', 'echo two'])
  assert.deepEqual(r.record.unset, ['KEY'])
  assert.equal(r.vars.MODE, 'branch')
  assert.equal(r.record.parent, 'main')
  const alone = await resolveEnvironment(applied(other), {}, '/p', 'e', 'AGENTS.md')
  assert.deepEqual(alone.record.overrides, [])
  assert.equal(alone.record.parent, null)
  assert.equal(alone.files.find((f) => f.path === 'a.txt')?.content, 'other')
  assert.ok(alone.files.some((f) => f.path === 'AGENTS.md' && f.content === 'Be terse.'))
})

test('SKILL.md frontmatter is parsed as YAML', () => {
  const md = (front: string, body = 'Body.\n') => `---\n${front}\n---\n${body}`
  assert.deepEqual(parseSkillMd(md('name: greet\ndescription: Says hi'), 's'), {
    name: 'greet',
    description: 'Says hi',
    body: 'Body.\n',
  })
  assert.equal(
    parseSkillMd(md('description: |\n  Line one.\n  Line two.\nname: greet'), 's').description,
    'Line one.\nLine two.',
    'literal block keeps newlines',
  )
  assert.equal(
    parseSkillMd(md('description: >\n  Folded one\n  and two.\n'), 's').description,
    'Folded one and two.',
    'folded block joins lines',
  )
  assert.equal(parseSkillMd(md('description: |-\n  Kept.'), 's').description, 'Kept.')
  assert.equal(
    parseSkillMd(md(`description: "Use when: it's \\"quoted\\""`), 's').description,
    `Use when: it's "quoted"`,
  )
  assert.equal(parseSkillMd(md("description: 'It''s single'"), 's').description, "It's single")
  assert.equal(
    parseSkillMd(md('description: A plain scalar\n  that wraps.'), 's').description,
    'A plain scalar that wraps.',
  )
  assert.equal(
    parseSkillMd('---\r\nname: crlf\r\ndescription: |\r\n  Windows.\r\n---\r\nBody', 's')
      .description,
    'Windows.',
  )
  assert.deepEqual(
    parseSkillMd('\uFEFF---\nname: bom\ndescription: Saved by Notepad\n---\nBody', 's'),
    {
      name: 'bom',
      description: 'Saved by Notepad',
      body: 'Body',
    },
  )
  assert.deepEqual(parseSkillMd('No frontmatter.', 's'), { body: 'No frontmatter.' })
  assert.deepEqual(parseSkillMd('---\n---\nBody', 's'), {
    name: undefined,
    description: undefined,
    body: 'Body',
  })
  assert.equal(parseSkillMd(md('description: a---b'), 's').description, 'a---b')
  assert.throws(() => parseSkillMd(md('description: Use when: x'), 's'), /isn't valid YAML/)
  assert.throws(() => parseSkillMd(md('description: 42'), 's'), /must be a string/)
  assert.throws(() => parseSkillMd(md('- a list'), 's'), /must be a YAML mapping/)
})

test('excludeMatcher is gitignore-style', () => {
  const m = excludeMatcher(DEFAULT_SKILL_EXCLUDE)
  assert.equal(m('evals', true), true)
  assert.equal(m('evals', false), false, 'a trailing / matches directories only')
  assert.equal(m('references/evals', true), false, 'a leading / anchors to the skill root')
  assert.equal(m('.history', true), true)
  assert.equal(m('scripts/.history', true), true, 'an unanchored name matches at any depth')
  assert.equal(m('greet.eval.ts', false), true)
  assert.equal(m('scripts/greet.eval.ts', false), true)
  assert.equal(m('scripts/greet.ts', false), false)
  assert.equal(m('greetXes.ts', false), false, 'dots are literal')
  const custom = excludeMatcher(['drafts/*.md', 'secret.txt'])
  assert.equal(custom('drafts/a.md', false), true)
  assert.equal(custom('x/drafts/a.md', false), false, 'an inner / anchors too')
  assert.equal(custom('drafts/sub/a.md', false), false, '* stays within a name')
  assert.equal(custom('deep/secret.txt', false), true)
})

test('directory() globs are ordered gitignore-style patterns: includes, excludes and re-includes', () => {
  const keep = (patterns: string[], path: string) => globFilter(patterns)(path)
  assert.equal(keep([], 'any/file.ts'), true, 'no pattern keeps everything')
  assert.equal(keep(['!*.md'], 'src/a.ts'), true, 'only excludes: everything else stays in')
  assert.equal(keep(['!*.md'], 'docs/a.md'), false, 'an unanchored name matches at any depth')
  const app = ['src/**', 'package.json', '!**/*.test.ts', '!src/gen/', 'src/gen/keep.ts']
  assert.equal(keep(app, 'src/deep/a.ts'), true, '** spans directories')
  assert.equal(keep(app, 'README.md'), false, 'with an include, what none matches is out')
  assert.equal(keep(app, 'package.json'), true)
  assert.equal(keep(app, 'lib/package.json'), true, 'package.json matches at any depth')
  assert.equal(keep(app, 'src/a.test.ts'), false, 'a later ! excludes')
  assert.equal(keep(app, 'src/gen/out.ts'), false, 'a trailing / excludes the directory')
  assert.equal(keep(app, 'src/gen/keep.ts'), true, 'a later include re-includes')
  assert.equal(keep(['src/*.ts'], 'src/a/b.ts'), false, '* stays within a name')
  assert.equal(keep(['/a.ts'], 'x/a.ts'), false, 'a leading / anchors')
  assert.equal(keep(['a?.[jt]s'], 'ab.ts'), true, '? and [ ] match one character')
  assert.equal(keep(['a.[!j]s'], 'a.js'), false, '[! ] negates a set')
  assert.equal(keep(['a.[^j]s'], 'a.ts'), true, 'so does [^ ]')
  assert.equal(keep(['a.ts'], 'aXts'), false, 'dots are literal')
  assert.equal(keep(['*.{md,txt}'], 'docs/a.txt'), true, 'braces list alternatives')
  assert.equal(keep(['*'], '.env'), true, 'wildcards match dotfiles')
  assert.equal(
    keep(['src/', '!src/x.ts'], 'src/x.ts'),
    false,
    'unlike gitignore, a ! still excludes a file in a directory a plain pattern named',
  )
  assert.equal(keep(['logs/'], 'logs'), false, 'a trailing / never matches a file')
  const ignored = globFilter(DEFAULT_DIRECTORY_IGNORES)
  assert.equal(ignored('build', true), true, 'build/ at the top is output')
  assert.equal(ignored('lib/build', true), false, 'a nested build/ can be source')
  assert.equal(ignored('packages/app/node_modules', true), true)
  assert.equal(
    ignored('vendor', true),
    false,
    'a committed vendor/ is source an offline build needs',
  )
  assert.equal(ignored('py/notes.pyc'), true)
})

test('directory() walks a host directory into files entries', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'reeval-directory-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const write = (path: string, content = path) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  for (const p of ['app/a.ts', 'app/.git/HEAD', 'app/.DS_Store', 'app/node_modules/x/i.js']) {
    write(p)
  }
  write('one.txt')
  mkdirSync(join(root, 'app/empty'))
  const { directory } = helpersFor(root)
  assert.deepEqual(directory('app'), { 'a.ts': { kind: 'file', path: join(root, 'app/a.ts') } })
  assert.deepEqual(
    Object.keys(directory('app', { defaultIgnores: false })),
    ['.DS_Store', 'a.ts', 'node_modules/x/i.js'],
    '.git is always left out, and an empty directory has no entry',
  )
  assert.deepEqual(Object.keys(directory('./app/', { into: 'web/' })), ['web/a.ts'])
  assert.deepEqual(Object.keys({ ...directory('app'), 'a.ts': 'x' }), ['a.ts'])
  assert.throws(() => directory('nope'), /directory\("nope"\): .*nope doesn't exist/)
  assert.throws(
    () => directory('one.txt'),
    /directory\("one\.txt"\): .*one\.txt is a file, not a directory\. Use file\("one\.txt"\) for one file\./,
  )
  assert.throws(() => directory('app', { glob: ['*.md'] }), /no files in .* match/)
  assert.throws(() => directory('app', { ignore: ['x'] } as never), /Exclude with a '!' pattern/)
  assert.throws(() => directory('app', { into: '../up' }), /into is a directory relative/)
  assert.throws(() => directory('app', { glob: 'src/**' } as never), /glob is a list of patterns/)
  if (process.platform === 'win32') return
  symlinkSync(join(root, 'one.txt'), join(root, 'app/linked.txt'))
  symlinkSync(join(root, 'app'), join(root, 'app/loop'))
  assert.throws(() => directory('app'), /loop is a symlink to a directory that contains it/)
  rmSync(join(root, 'app/loop'))
  assert.deepEqual(directory('app')['linked.txt'], {
    kind: 'file',
    path: join(root, 'app/linked.txt'),
  })
  symlinkSync(join(root, 'gone'), join(root, 'app/dangling'))
  assert.throws(() => directory('app'), /dangling is a symlink to something that doesn't exist/)
})

test("a host file's executable bit is kept and feeds the digest", async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'reeval-directory-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'run.sh'), 'echo ran')
  const env = defineEnvironment('modes', ({ directory }) => ({ files: directory(root) }))
  const resolve = () => resolveEnvironment(applied(env), {}, root, 'e', 'AGENTS.md')
  chmodSync(join(root, 'run.sh'), 0o644)
  const plain = await resolve()
  assert.deepEqual(plain.files[0], { path: 'run.sh', content: Buffer.from('echo ran') })
  if (process.platform === 'win32') return
  chmodSync(join(root, 'run.sh'), 0o755)
  const executable = await resolve()
  assert.equal(executable.files[0]?.executable, true)
  assert.notEqual(executable.record.digest, plain.record.digest)
})

test('skill directories leave out eval material, recorded as excluded', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reeval-skill-'))
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  write(
    'skills/greet/SKILL.md',
    '---\nname: greet\ndescription: |\n  Greets.\n  Politely.\n---\nHi.',
  )
  write('skills/greet/references/tone.md', 'Warm.')
  write('skills/greet/references/evals/notes.md', 'Kept: only the root evals/ is eval material.')
  write('skills/greet/evals/evals.json', '{"prompts":["secret"]}')
  write('skills/greet/evals/.history/run.json', '{}')
  write('skills/greet/greet.eval.ts', 'evaluate()')
  write('skills/greet/scripts/.history/x', 'x')
  write('skills/greet/.git/HEAD', 'ref: refs/heads/main')
  write('skills/greet/drafts/next.md', 'WIP')
  try {
    const env = (exclude?: string[]) =>
      defineEnvironment('e', ({ skill }) => ({
        skills: [skill.local(join(root, 'skills'), exclude ? { exclude } : {})],
      }))
    const r = await resolveEnvironment(applied(env()), {}, root, 'e', 'AGENTS.md')
    const [s] = r.skills
    assert.equal(s?.description, 'Greets.\nPolitely.')
    assert.deepEqual(
      s?.files.map((f) => f.path),
      ['drafts/next.md', 'references/evals/notes.md', 'references/tone.md'],
    )
    assert.deepEqual(r.record.skills[0]?.excluded, ['evals/', 'greet.eval.ts', 'scripts/.history/'])

    const custom = await resolveEnvironment(
      applied(env([...DEFAULT_SKILL_EXCLUDE, 'drafts/'])),
      {},
      root,
      'e',
      'AGENTS.md',
    )
    assert.deepEqual(custom.record.skills[0]?.excluded, [
      'drafts/',
      'evals/',
      'greet.eval.ts',
      'scripts/.history/',
    ])
    assert.notEqual(custom.record.skills[0]?.sha256, r.record.skills[0]?.sha256)

    const none = await resolveEnvironment(applied(env([])), {}, root, 'e', 'AGENTS.md')
    assert.deepEqual(none.record.skills[0]?.excluded, [], 'an empty list replaces the defaults')
    assert.ok(none.skills[0]?.files.some((f) => f.path === 'evals/evals.json'))
    assert.ok(!none.skills[0]?.files.some((f) => f.path.startsWith('.git/')), '.git always goes')

    writeFileSync(join(root, 'skills/greet/evals/evals.json'), '{"prompts":["changed"]}')
    const edited = await resolveEnvironment(applied(env()), {}, root, 'e', 'AGENTS.md')
    assert.equal(edited.record.digest, r.record.digest, 'editing evals keeps the fingerprint')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  assert.throws(
    () =>
      defineEnvironment('bad', ({ skill }) => ({ skills: [skill.local('.', { exclude: ['/'] })] })),
    /skill\(\{ exclude \}\) must be a list of paths or globs/,
  )
})

test('git refs and repo shorthands', () => {
  assert.equal(isMovingRef('main'), true)
  assert.equal(isMovingRef(undefined), true)
  assert.equal(isMovingRef('feature/x'), true)
  assert.equal(isMovingRef('v2.4.0'), false)
  assert.equal(isMovingRef('0.3.0'), false)
  assert.equal(isMovingRef('a1b2c3d'), false)
  assert.deepEqual(parseGitRepo('github:invertase/genkit-skills'), {
    url: 'https://github.com/invertase/genkit-skills.git',
  })
  assert.deepEqual(parseGitRepo('https://github.com/invertase/skills/tree/v1/skills/genkit'), {
    url: 'https://github.com/invertase/skills.git',
    ref: 'v1',
    path: 'skills/genkit',
  })
})

test('git(): URLs, GitHub shorthands and local paths, resolved against the calling file', () => {
  const { git } = helpersFor('/p/evals')
  assert.deepEqual(git('https://github.com/acme/app', { ref: 'v1', path: 'examples/basic/' }), {
    kind: 'git',
    repo: 'https://github.com/acme/app',
    url: 'https://github.com/acme/app',
    ref: 'v1',
    path: 'examples/basic',
  })
  assert.deepEqual(git('github:acme/app'), {
    kind: 'git',
    repo: 'github:acme/app',
    url: 'https://github.com/acme/app.git',
  })
  assert.deepEqual(git('https://github.com/acme/app/tree/v2/apps/web'), {
    kind: 'git',
    repo: 'https://github.com/acme/app',
    url: 'https://github.com/acme/app.git',
    ref: 'v2',
    path: 'apps/web',
  })
  assert.equal(git('../fixtures/app').url, resolve('/p/evals', '../fixtures/app'))
  assert.equal(git('git@github.com:acme/app.git').url, 'git@github.com:acme/app.git')
  assert.throws(() => git('https://tok@github.com/acme/app'), /password or token in it/)
  assert.throws(() => git('github:acme/app', { ref: '--upload-pack=x' }), /ref is a branch/)
  assert.throws(
    () => git('github:acme/app', { path: '../secrets' }),
    /^DefinitionError: git\("github:acme\/app"\): path is a directory in the repository, relative, with forward slashes and no \. or \.\. \(got "\.\.\/secrets"\)$/,
  )
  assert.throws(
    () => git('github:acme/app', { branch: 'main' } as never),
    /git\("github:acme\/app"\): unknown option "branch"; it takes ref, path, init and token\. Use ref for a branch, tag or commit\./,
  )
  assert.deepEqual(git('github:acme/app', { ref: 'v1', init: true, token: 'GITHUB_TOKEN' }), {
    kind: 'git',
    repo: 'github:acme/app',
    url: 'https://github.com/acme/app.git',
    ref: 'v1',
    init: true,
    token: 'GITHUB_TOKEN',
  })
  assert.throws(() => git('github:acme/app', { init: 'yes' } as never), /init is true or false/)
  for (const pasted of ['ghp_abcdef1234567890', 'glpat-abc123', 'not a name']) {
    assert.throws(
      () => git('github:acme/app', { token: pasted }),
      (error: Error) =>
        /token names the host variable that holds the token, e\.g\. token: 'GITHUB_TOKEN'\. Don't put the token itself in the eval\.$/.test(
          error.message,
        ) && !error.message.includes(pasted),
    )
  }
  assert.throws(
    () => git('git@github.com:acme/app.git', { token: 'GITHUB_TOKEN' }),
    /token only works with an https:\/\/ URL; for SSH or a local repository, git uses this machine's own credentials/,
  )
  assert.throws(() => git('../fixtures/app', { token: 'GITHUB_TOKEN' }), /token only works/)
  assert.throws(
    () => defineEnvironment('app', { repo: 'github:acme/app' } as never),
    /Unknown field "repo" in defineEnvironment\("app"\)\. Did you mean "workspace"\?/,
  )
})

test('selectProfile: --profile, then REEVAL_PROFILE, then defaultProfile', () => {
  const config = resolveConfig(
    {
      budget: { attempts: 50 },
      defaultProfile: { ci: 'pr', local: 'dev' },
      profiles: { pr: { budget: { duration: '1h' } }, dev: {}, nightly: { record: 'always' } },
    },
    '/p',
  )
  assert.equal(selectProfile(config, 'nightly', {})?.reason, '--profile')
  assert.equal(selectProfile(config, undefined, { REEVAL_PROFILE: 'nightly' })?.name, 'nightly')
  const ci = selectProfile(config, undefined, { CI: 'true' })
  assert.deepEqual(
    [ci?.name, ci?.reason, ci?.budget],
    ['pr', 'auto: CI is set', { attempts: 50, duration: '1h' }],
  )
  assert.equal(selectProfile(config, undefined, {})?.reason, 'default')
  assert.throws(
    () => selectProfile(config, 'nope', {}),
    /Unknown profile "nope"\. Profiles in reeval\.config\.ts: pr, dev, nightly\./,
  )
})
