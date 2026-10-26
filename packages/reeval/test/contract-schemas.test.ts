import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { checkContractCoverage, differences, withZodDefs, zodDefs } from '../scripts/schema/zod.ts'
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

test('the drift guard names a property or required flag that differs, not a description', () => {
  const owned = zodDefs({ Thing: thing.omit({ timeout: true }) })
  assert.deepEqual(differences(generated, owned.Thing ?? {}), [])
  const drift = [
    { ...generated, required: ['kind'] },
    { ...generated, properties: { ...generated.properties, colour: { type: 'string' as const } } },
    { ...generated, properties: { ...generated.properties, name: { description: 'Name.' } } },
    { ...generated, description: 'Another thing.' },
  ].map((g) => differences(g, owned.Thing ?? {}))
  assert.deepEqual(drift, [
    ['type only:  name?', 'Zod only:   name'],
    ['type only:  colour?'],
    [],
    [],
  ])
  assert.throws(
    () => withZodDefs({ Thing: { ...generated, required: ['kind'] } }, owned),
    /Thing's TypeScript type and its Zod schema in src\/contract\/ disagree:\n {2}type only: {2}name\?/,
  )
})

const undescribed = z.strictObject({
  kind: z.literal('thing'),
  name: z.string(),
  size: z.number().optional(),
})

test('the descriptions come from the type, wherever its schema appears', () => {
  const holder = z.strictObject({
    thing: undescribed.optional(),
    things: z.array(undescribed),
    either: z.union([z.string(), undescribed]),
  })
  const typedHolder = {
    type: 'object' as const,
    properties: { thing: { description: 'The thing it holds.', $ref: '#/$defs/Thing' } },
  }
  const owned = zodDefs({ Holder: holder }, {}, [
    { name: 'Thing', schema: undescribed, typed: generated },
    { name: 'Holder', schema: holder, typed: typedHolder },
  ])
  const inlined = owned.Holder?.properties ?? {}
  assert.equal(inlined.thing?.description, 'The thing it holds.')
  assert.equal(inlined.thing?.properties?.name?.description, 'Its name.')
  assert.equal(inlined.things?.items?.description, 'A thing.')
  assert.equal(inlined.things?.items?.properties?.name?.description, 'Its name.')
  assert.equal(inlined.either?.anyOf?.[1]?.description, 'A thing.')
  assert.equal(inlined.either?.anyOf?.[0]?.description, undefined)
  assert.equal(owned.Holder?.description, undefined)
})

test('a .describe() the TSDoc already gives is refused, and a shared type fills only the gaps', () => {
  const typed = {
    ...generated,
    properties: { ...generated.properties, size: { description: 'Its size.' } },
  }
  const docs = (schema: z.ZodType, shared?: boolean) => [{ name: 'Thing', schema, typed, shared }]
  const repeated = undescribed.extend({ name: z.string().describe('Its name.') })
  assert.throws(
    () => zodDefs({ Thing: repeated }, {}, docs(repeated)),
    /Thing\.name: its Zod schema's \.describe\(\) repeats the TSDoc "Its name\."/,
  )
  assert.throws(() => zodDefs({ Thing: repeated }, {}, docs(repeated, true)), /repeats/)
  const wire = undescribed
    .extend({ name: z.string().describe('The name on the wire.') })
    .describe('A thing on the wire.')
  assert.throws(() => zodDefs({ Thing: wire }, {}, docs(wire)), /Thing\.name: .* contradicts/)
  const shared = zodDefs({ Thing: wire }, {}, docs(wire, true)).Thing
  assert.equal(shared?.description, 'A thing on the wire.')
  assert.equal(shared?.properties?.name?.description, 'The name on the wire.')
  assert.equal(shared?.properties?.size?.description, 'Its size.')
})

test('every contract schema is checked against its type, or listed as Zod-only with why', () => {
  const schemas = { Thing: thing, Duration: durationSchema }
  assert.doesNotThrow(() => checkContractCoverage(new Set(['Thing']), schemas, { Duration: 'why' }))
  assert.throws(
    () => checkContractCoverage(new Set(['Other']), schemas, { Duration: 'why' }),
    /^Error: Thing is in CONTRACT_SCHEMAS but no plan type has a def by that name/,
  )
  assert.throws(
    () => checkContractCoverage(new Set(['Thing', 'Duration']), schemas, { Duration: 'why' }),
    /Duration is in ZOD_ONLY but a plan type has a def for it now/,
  )
  assert.throws(
    () => checkContractCoverage(new Set(['Thing']), { Thing: thing }, { Duration: 'why' }),
    /Duration is in ZOD_ONLY but not in CONTRACT_SCHEMAS/,
  )
})

test('a union’s variants are told apart by their constant fields', () => {
  const pets = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('cat'), meow: z.string() }),
    z.strictObject({ kind: z.literal('dog'), bark: z.string() }),
  ])
  const variant = (kind: string, key: string, description: string) => ({
    type: 'object' as const,
    properties: { kind: { const: kind }, [key]: { type: 'string' as const, description } },
    required: ['kind', key],
  })
  const pet = { anyOf: [variant('dog', 'bark', 'Its bark.'), variant('cat', 'meow', 'Its meow.')] }
  const owned = zodDefs({ Pet: pets }, {}, [{ name: 'Pet', schema: pets, typed: pet }])
  assert.deepEqual(differences(pet, owned.Pet ?? {}), [])
  const [cat, dog] = owned.Pet?.oneOf ?? []
  assert.equal(cat?.properties?.meow?.description, 'Its meow.')
  assert.equal(dog?.properties?.bark?.description, 'Its bark.')
  const swapped = { anyOf: [variant('cat', 'bark', ''), variant('dog', 'meow', '')] }
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
