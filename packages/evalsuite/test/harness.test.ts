import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { normaliseStream } from '../src/harness/transcript.ts'

describe('Claude Code transcripts', () => {
  test('its Edit and Write tools are file edits, keyed by file_path', () => {
    const call = (id: string, toolName: string, input: unknown) => ({
      ms: 10,
      part: { type: 'tool-call', toolCallId: id, toolName, input },
    })
    const result = (id: string, output: unknown) => ({
      ms: 20,
      part: { type: 'tool-result', toolCallId: id, output },
    })
    const events = normaliseStream(
      [
        call('w', 'write', { file_path: '/es/workspace/greet.js', content: 'hi\n' }),
        result('w', 'ok'),
        call('e', 'edit', { file_path: 'greet.js', old_string: 'hi', new_string: 'hello' }),
        result('e', 'ok'),
        call('b', 'bash', { command: 'ls' }),
        result('b', 'greet.js'),
        { ms: 30, part: { type: 'error', error: { message: 'process exited with code 1' } } },
      ],
      0,
    )
    assert.deepEqual(
      events.map((e) => [e.type, 'path' in e ? e.path : 'tool' in e ? e.tool : '']),
      [
        ['file-edit', '/es/workspace/greet.js'],
        ['file-edit', 'greet.js'],
        ['tool', 'bash'],
        ['error', ''],
      ],
    )
    assert.equal(
      events.at(-1)?.type === 'error' && events.at(-1)?.message,
      'process exited with code 1',
    )
  })

  const call = (id: string, toolName: string, input: unknown) => ({
    ms: 10,
    part: { type: 'tool-call', toolCallId: id, toolName, input },
  })
  const result = (id: string, output: unknown) => ({
    ms: 20,
    part: { type: 'tool-result', toolCallId: id, output },
  })

  test('its Write and Edit results say what changed and by how many lines', () => {
    const greet =
      'function greet(name) {\n  return "Hello, " + name;\n}\n\nmodule.exports = { greet };\n'
    const events = normaliseStream(
      [
        call('w', 'write', { file_path: 'greet.js', content: greet }),
        result('w', {
          type: 'create',
          filePath: 'greet.js',
          content: greet,
          structuredPatch: [],
          originalFile: null,
          userModified: false,
        }),
        call('e', 'edit', {
          file_path: 'greet.js',
          old_string: 'function greet(name) {',
          new_string: 'function greet(name = "world") {',
          replace_all: false,
        }),
        result('e', {
          filePath: 'greet.js',
          oldString: 'function greet(name) {',
          newString: 'function greet(name = "world") {',
          originalFile: greet,
          structuredPatch: [
            {
              oldStart: 1,
              oldLines: 4,
              newStart: 1,
              newLines: 4,
              lines: [
                '-function greet(name) {',
                '+function greet(name = "world") {',
                '   return "Hello, " + name;',
                ' }',
                ' ',
              ],
            },
          ],
          userModified: false,
          replaceAll: false,
        }),
        call('u', 'write', { file_path: '/es/workspace/notes.md', content: 'a\nb\n' }),
        result('u', {
          type: 'update',
          filePath: '/es/workspace/notes.md',
          content: 'a\nb\n',
          structuredPatch: [],
          originalFile: 'a\n',
        }),
      ],
      0,
    )
    assert.deepEqual(
      events.map((e) =>
        e.type === 'file-edit' ? [e.path, e.kind, e.added, e.removed] : [e.type, '', 0, 0],
      ),
      [
        ['greet.js', 'create', 5, 0],
        ['greet.js', 'modify', 1, 1],
        ['/es/workspace/notes.md', 'modify', 1, 0],
      ],
    )
  })

  test("its WebSearch and WebFetch calls become web events, like Cursor's", () => {
    const events = normaliseStream(
      [
        call('s', 'webSearch', { query: 'node test runner' }),
        result('s', {
          query: 'node test runner',
          results: [
            {
              tool_use_id: 'srvtoolu_1',
              content: [
                { title: 'Test runner', url: 'https://nodejs.org/api/test.html' },
                { title: 'node:test', url: 'https://example.com/node-test' },
              ],
            },
            'Two results about node:test.',
          ],
          durationSeconds: 1.2,
        }),
        call('f', 'WebFetch', { url: 'https://nodejs.org/api/test.html', prompt: 'summarise' }),
        result('f', {
          bytes: 10,
          code: 200,
          codeText: 'OK',
          result: 'x',
          durationMs: 5,
          url: 'https://nodejs.org/api/test.html',
        }),
        call('m', 'WebFetch', { url: 'https://example.com/missing', prompt: 'summarise' }),
        result('m', { code: 404, codeText: 'Not Found', url: 'https://example.com/missing' }),
        call('c', 'webSearch', { searchTerm: 'cursor search' }),
        result('c', { referenceCount: 3 }),
      ],
      0,
    )
    assert.deepEqual(
      events.map((e) =>
        e.type === 'web-search'
          ? [e.type, e.query, e.references]
          : e.type === 'web-fetch'
            ? [e.type, e.url, e.ok]
            : [e.type],
      ),
      [
        ['web-search', 'node test runner', 2],
        ['web-fetch', 'https://nodejs.org/api/test.html', true],
        ['web-fetch', 'https://example.com/missing', false],
        ['web-search', 'cursor search', 3],
      ],
    )
  })
})
