import assert from 'node:assert/strict'
import { test } from 'node:test'
import camelCase from './index.js'

test('separators split words', () => {
  assert.equal(camelCase('foo/bar', { separators: '/' }), 'fooBar')
  assert.equal(camelCase('user:first name', { separators: ':' }), 'userFirstName')
  assert.equal(camelCase(['a/b', 'c'], { separators: '/' }), 'aBC')
  assert.equal(camelCase('foo/bar', { separators: '/', pascalCase: true }), 'FooBar')
})

test('without separators, nothing changes', () => {
  assert.equal(camelCase('foo/bar'), 'foo/bar')
  assert.equal(camelCase('foo-bar'), 'fooBar')
})
