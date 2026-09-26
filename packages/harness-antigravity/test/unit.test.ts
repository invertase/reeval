import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { HARNESS_V1_BUILTIN_TOOL_NAMES } from '@ai-sdk/harness'
import {
  ANTIGRAVITY_BUILTIN_TOOLS,
  ANTIGRAVITY_CLI_SHA256,
  ANTIGRAVITY_CLI_VERSION,
  antigravityEndpoints,
  antigravityInstallScript,
  buildAntigravityCommand,
  createAntigravityRequestTransformations,
  getAntigravityBootstrap,
  projectToolCall,
  resolveAntigravityCredentials,
  VERSION,
} from '../src/index.ts'

describe('auth', () => {
  test("'auto' uses only GEMINI_API_KEY from the host", () => {
    assert.deepEqual(
      resolveAntigravityCredentials('auto', {
        GEMINI_API_KEY: 'gk',
        GOOGLE_API_KEY: 'other',
        AI_GATEWAY_API_KEY: 'gateway',
      }),
      { apiKey: 'gk' },
    )
  })

  test('an environment object is the only source, and carries the base URL', () => {
    assert.deepEqual(
      resolveAntigravityCredentials(
        { GEMINI_API_KEY: 'explicit', GOOGLE_GEMINI_BASE_URL: 'https://proxy.example/g' },
        { GEMINI_API_KEY: 'host' },
      ),
      { apiKey: 'explicit', baseUrl: 'https://proxy.example/g' },
    )
    assert.throws(
      () => resolveAntigravityCredentials({ OTHER: 'x' }, { GEMINI_API_KEY: 'host' }),
      /GEMINI_API_KEY isn't set/,
    )
  })

  test('a missing key or an unknown mode is an error that names the fix', () => {
    assert.throws(() => resolveAntigravityCredentials('auto', {}), /Gemini API key/)
    assert.throws(
      () => resolveAntigravityCredentials('ai-gateway' as never, { GEMINI_API_KEY: 'k' }),
      /must be 'auto' or an environment object/,
    )
  })

  test('the key is swapped in only for the placeholder, on the Gemini API host', () => {
    assert.deepEqual(
      createAntigravityRequestTransformations({
        credentials: { apiKey: 'real' },
        placeholder: 'aisdkhc_x',
      }),
      [
        {
          match: {
            host: 'generativelanguage.googleapis.com',
            headers: [{ key: { exact: 'x-goog-api-key' }, value: { exact: 'aisdkhc_x' } }],
          },
          transform: { headers: { 'x-goog-api-key': 'real' } },
        },
      ],
    )
  })

  test('the endpoint pattern matches what the CLI sends, and nothing else', () => {
    const [endpoint] = antigravityEndpoints()
    const re = new RegExp(endpoint.path.regex)
    for (const path of [
      '/v1beta/models/gemini-3.8-flash:streamGenerateContent',
      '/v1beta/models/gemini-3.1-flash-lite-preview:streamGenerateContent',
    ]) {
      assert.ok(re.test(path), path)
    }
    for (const path of [
      '/v1beta/models',
      '/v1beta/files',
      '/v1beta/models/x:generateContent',
      '/v1beta/models/a/b:streamGenerateContent',
      '/upload/v1beta/models/x:streamGenerateContent',
    ]) {
      assert.ok(!re.test(path), path)
    }
  })

  test('a base URL moves the rule and the endpoint to its host and path prefix', () => {
    const [rule] = createAntigravityRequestTransformations({
      credentials: { apiKey: 'k', baseUrl: 'https://gw.example.com/google/' },
      placeholder: 'p',
    })
    assert.equal(rule?.match.host, 'gw.example.com')
    assert.deepEqual(rule?.match.path, { startsWith: '/google' })
    const [endpoint] = antigravityEndpoints('https://gw.example.com/google/')
    assert.equal(endpoint.host, 'gw.example.com')
    assert.ok(new RegExp(endpoint.path.regex).test('/google/v1beta/models/m:streamGenerateContent'))
    assert.ok(!new RegExp(endpoint.path.regex).test('/v1beta/models/m:streamGenerateContent'))
  })
})

describe('tools', () => {
  test('the catalog and its common names', () => {
    const common = Object.fromEntries(
      Object.entries(ANTIGRAVITY_BUILTIN_TOOLS).flatMap(([key, t]) =>
        'commonName' in t && t.commonName ? [[key, t.nativeName]] : [],
      ),
    )
    assert.deepEqual(common, {
      bash: 'run_command',
      read: 'view_file',
      write: 'write_to_file',
      edit: 'replace_file_content',
      grep: 'grep_search',
      glob: 'find_by_name',
      webSearch: 'search_web',
    })
    for (const name of Object.keys(common)) {
      assert.ok((HARNESS_V1_BUILTIN_TOOL_NAMES as readonly string[]).includes(name))
    }
  })

  test('native parameters are kept, and the common fields added', () => {
    assert.deepEqual(projectToolCall('multi_replace_file_content', { TargetFile: '/w/a.ts' }), {
      toolName: 'edit',
      nativeName: 'multi_replace_file_content',
      input: { TargetFile: '/w/a.ts', file_path: '/w/a.ts' },
      dynamic: false,
    })
    assert.deepEqual(projectToolCall('grep_search', { Query: 'beta', SearchPath: '/w' }).input, {
      Query: 'beta',
      SearchPath: '/w',
      pattern: 'beta',
      path: '/w',
    })
    assert.deepEqual(projectToolCall('list_dir', { DirectoryPath: '/w' }), {
      toolName: 'list_dir',
      nativeName: 'list_dir',
      input: { DirectoryPath: '/w' },
      dynamic: false,
    })
    assert.equal(projectToolCall('manage_task', {}).dynamic, true)
  })
})

describe('command', () => {
  const base = { cli: '/root/.ai-sdk-harness/bin/agy', workDir: '/es/workspace', promptFile: '/p' }

  test('the default turn', () => {
    assert.equal(
      buildAntigravityCommand(base),
      "exec '/root/.ai-sdk-harness/bin/agy' '--output-format' 'stream-json' '--add-dir' '/es/workspace' '--disable-slash-commands' '--print-timeout' '0' '--dangerously-skip-permissions' -p \"$(cat '/p')\"",
    )
  })

  test('model, effort, resume and schema come before -p, which is last', () => {
    const command = buildAntigravityCommand({
      ...base,
      model: 'gemini-3.8-flash-low',
      effort: 'high',
      conversationId: 'abc',
      jsonSchemaFile: '/s.json',
      permissionMode: 'allow-edits',
    })
    assert.match(command, /'--model' 'gemini-3\.8-flash-low' '--effort' 'high'/)
    assert.match(
      command,
      /'--mode' 'accept-edits' '--conversation' 'abc' '--json-schema' '\/s\.json'/,
    )
    assert.doesNotMatch(command, /dangerously/)
    assert.ok(command.endsWith(`-p "$(cat '/p')"`))
  })

  test("paths are quoted, so a quote can't break out", () => {
    const command = buildAntigravityCommand({ ...base, workDir: "/es/it's here" })
    assert.match(command, /'\/es\/it'\\''s here'/)
  })

  test('read-only turns plan', () => {
    assert.match(
      buildAntigravityCommand({ ...base, permissionMode: 'allow-reads' }),
      /'--mode' 'plan'/,
    )
  })
})

describe('bootstrap', () => {
  test('pins the release and checks its sha256 on both architectures', async () => {
    const script = antigravityInstallScript()
    assert.match(script, new RegExp(`/download/${ANTIGRAVITY_CLI_VERSION.replace(/\./g, '\\.')}/`))
    assert.ok(script.includes(ANTIGRAVITY_CLI_SHA256.x64))
    assert.ok(script.includes(ANTIGRAVITY_CLI_SHA256.arm64))
    assert.match(script, /sha256sum -c/)
    assert.match(script, /mv bin\/antigravity bin\/agy/)
    const bootstrap = await getAntigravityBootstrap()
    assert.deepEqual(
      { ...bootstrap, files: bootstrap.files.map((f) => f.path) },
      {
        harnessId: 'antigravity',
        bootstrapDir: '.harness-bootstrap/antigravity',
        files: ['.harness-bootstrap/antigravity/install.sh'],
        commands: [{ command: 'sh install.sh' }],
      },
    )
  })
})

test('VERSION matches package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(VERSION, pkg.version)
})
