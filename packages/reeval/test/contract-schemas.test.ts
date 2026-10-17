import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { differences, withZodDefs, zodDefs } from '../scripts/schema/zod.ts'
import { closest, durationProblem, durationSchema, refusal } from '../src/contract/shared.ts'

const generated = {
  description: 'A thing.',
  type: 'object' as const,
  properties: {
    kind: { const: 'thing' },
    name: { description: 'Its name.', type: 'string' as const },
    size: { type: 'number' as const },
  },
  required: ['kind', 'name'],
}

const thing = z
  .strictObject({
    kind: z.literal('thing'),
    name: z.string().describe('Its name.'),
    size: z.number().optional(),
    timeout: durationSchema.optional(),
  })
  .describe('A thing.')

test('withZodDefs swaps in Zod’s def and adds the Zod-only defs it refers to', () => {
  const owned = zodDefs({ Thing: thing, Duration: durationSchema })
  const out = withZodDefs(
    { Thing: { ...generated, properties: { ...generated.properties, timeout: {} } } },
    owned,
  )
  assert.deepEqual(Object.keys(out), ['Duration', 'Thing'])
  assert.equal(out.Thing?.properties?.timeout?.$ref, '#/$defs/Duration')
  assert.equal((out.Thing as { additionalProperties?: boolean }).additionalProperties, false)
})

test('the drift guard names a property, required flag or description that differs', () => {
  const owned = zodDefs({ Thing: thing.omit({ timeout: true }).describe('A thing.') })
  assert.deepEqual(differences(generated, owned.Thing ?? {}), [])
  const drift = [
    { ...generated, required: ['kind'] },
    { ...generated, properties: { ...generated.properties, colour: { type: 'string' as const } } },
    { ...generated, properties: { ...generated.properties, name: { description: 'Name.' } } },
    { ...generated, description: 'Another thing.' },
  ].map((g) => differences(g, owned.Thing ?? {}))
  assert.deepEqual(drift, [
    ['type only:  name?: Its name.', 'Zod only:   name: Its name.'],
    ['type only:  colour?'],
    ['type only:  name: Name.', 'Zod only:   name: Its name.'],
    ['type only:  (description) Another thing.', 'Zod only:   (description) A thing.'],
  ])
  assert.throws(
    () => withZodDefs({ Thing: { ...generated, required: ['kind'] } }, owned),
    /Thing's TypeScript type and its Zod schema in src\/contract\/ disagree:\n {2}type only: {2}name\?/,
  )
})

test('a union’s variants are told apart by their constant fields', () => {
  const owned = zodDefs({
    Pet: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('cat'), name: z.string().describe('Cat name.') }),
      z.strictObject({ kind: z.literal('dog'), name: z.string().describe('Dog name.') }),
    ]),
  })
  const variant = (kind: string, description: string) => ({
    type: 'object' as const,
    properties: { kind: { const: kind }, name: { type: 'string' as const, description } },
    required: ['kind', 'name'],
  })
  const pet = { anyOf: [variant('cat', 'Cat name.'), variant('dog', 'Dog name.')] }
  assert.deepEqual(differences(pet, owned.Pet ?? {}), [])
  const swapped = { anyOf: [variant('cat', 'Dog name.'), variant('dog', 'Cat name.')] }
  assert.equal(differences(swapped, owned.Pet ?? {}).length, 4)
})

test('refusal explains the first issue in the order the old checks ran, skipping deferred keys', () => {
  const schema = z.strictObject({ a: z.number(), b: z.number(), c: z.number().optional() })
  const explain = (issue: z.core.$ZodIssue) => `${issue.code} ${issue.path.join('.')}`
  assert.equal(refusal(schema, { a: 1, b: 2 }, explain), undefined)
  assert.equal(
    refusal(schema, { a: 'x', b: 'y' }, explain, { order: ['b', 'a'] }),
    'invalid_type b',
  )
  assert.equal(refusal(schema, { a: 'x', b: 2, d: 1 }, explain), 'unrecognized_keys ')
  assert.equal(refusal(schema, { a: 1, b: 2, c: 'x' }, explain, { skip: ['c'] }), undefined)
})

test('closest suggests a likely typo and nothing else', () => {
  const keys = ['model', 'effort', 'params', 'id', 'maxConcurrent', 'text']
  assert.deepEqual(
    ['modle', 'efort', 'Model', 'txt', 'maxconcurrent', 'colour', 'x', 'params2'].map((k) =>
      closest(k, keys),
    ),
    ['model', 'effort', 'model', 'text', 'maxConcurrent', undefined, undefined, 'params'],
  )
})

test('durationSchema and parseDuration agree', () => {
  for (const value of [
    '90s',
    '1.5m',
    '100ms',
    '2h',
    1,
    0.5,
    '0s',
    '0',
    0,
    -1,
    '-5s',
    'soon',
    '5x',
    '1m ',
  ]) {
    assert.equal(
      durationSchema.safeParse(value).success,
      durationProblem(value) === undefined,
      JSON.stringify(value),
    )
  }
})
