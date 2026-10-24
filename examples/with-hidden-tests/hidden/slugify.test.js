import assert from 'node:assert/strict'
import { test } from 'node:test'
import { slugify } from '../src/slugify.js'

test('lower-cases and joins words with hyphens', () => {
  assert.equal(slugify('Hello World'), 'hello-world')
})

test('drops punctuation', () => {
  assert.equal(slugify('Ship it, now!'), 'ship-it-now')
})

test('collapses and trims spaces', () => {
  assert.equal(slugify('  many   spaces  '), 'many-spaces')
})
