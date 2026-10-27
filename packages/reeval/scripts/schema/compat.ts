// Compares a persisted shape's committed schema with the one the code describes now, and says
// whether files written under the old one still read under the new one (and the other way round).
import { resolve, type Schema, type ShapeSchema } from './generate.ts'

export type Change = {
  /** Where, e.g. `evals[].attempts[].egress` or `<type=tool>.ok`; empty for the whole shape. */
  path: string
  kind:
    | 'added-optional'
    | 'added-defaulted'
    | 'added-required'
    | 'made-required'
    | 'removed'
    | 'narrowed'
    | 'widened'
    | 'default-unused'
    | 'version'
  /** Breaks reading files written before (or, for `removed`, by) this version. */
  breaking: boolean
  message: string
}

export type CompatOptions = {
  /** Paths with a read default in `READ_DEFAULTS` (src/view/record.ts). */
  defaults: string[]
  /** `from` versions with a migration in `MIGRATIONS` (src/view/record.ts). */
  migrations: number[]
}

type Doc = Pick<ShapeSchema, '$defs'>

const join = (path: string, segment: string) => (path ? `${path}.${segment}` : segment)
const shown = (path: string) => `\`${path || '(the whole value)'}\``

/** A schema in a word or two, for messages. */
export function describe(doc: Doc, schema: Schema): string {
  if (schema.$ref) return schema.$ref.replace('#/$defs/', '')
  if ('const' in schema) return JSON.stringify(schema.const)
  if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(' | ')
  if (schema.anyOf) return schema.anyOf.map((s) => describe(doc, s)).join(' | ')
  if (schema.type === 'array') return `${describe(doc, schema.items ?? {})}[]`
  if (schema.type === 'object') return schema.additionalProperties ? 'Record<string, …>' : '{ … }'
  return schema.type ?? 'unknown'
}

/** A schema's alternatives, `$ref`s resolved and enums split into consts. */
function alternatives(doc: Doc, schema: Schema): Schema[] {
  const s = resolve(doc, schema)
  if (s.anyOf) return s.anyOf.flatMap((a) => alternatives(doc, a))
  if (s.enum) return s.enum.map((v) => ({ const: v }))
  return [s]
}

const kindOf = (s: Schema) =>
  Object.keys(s).length === 0 ? 'any' : 'const' in s ? 'const' : (s.type ?? 'any')

/** The property whose const value tells a union's object alternatives apart, if one does. */
function discriminant(doc: Doc, objects: Schema[]): string | null {
  if (objects.length < 2) return null
  const first = objects[0]?.properties ?? {}
  for (const key of Object.keys(first)) {
    const values = objects.map((o) => {
      const p = o.properties?.[key]
      return p && o.required?.includes(key) ? alternatives(doc, p) : null
    })
    if (values.some((v) => !v || v.some((a) => !('const' in a)))) continue
    const all = values.flatMap((v) => (v ?? []).map((a) => a.const))
    if (new Set(all).size === all.length) return key
  }
  return null
}

const constsOf = (doc: Doc, o: Schema, key: string) =>
  alternatives(doc, o.properties?.[key] ?? {}).map((a) => a.const)

/** A `description` is documentation: changing, adding or removing one is never a change here. */
export function compare(
  oldDoc: ShapeSchema,
  newDoc: ShapeSchema,
  options: CompatOptions,
): Change[] {
  const changes: Change[] = []
  const defaults = new Set(options.defaults)
  const seen = new Set<string>()

  const add = (path: string, kind: Change['kind'], breaking: boolean, message: string) =>
    changes.push({ path, kind, breaking, message })

  const values = (s: Schema[]) => s.map((a) => describe(newDoc, a)).join(' | ')

  function walk(before: Schema, after: Schema, path: string) {
    const key = `${path}\0${before.$ref ?? JSON.stringify(before)}\0${after.$ref ?? JSON.stringify(after)}`
    if (seen.has(key)) return
    seen.add(key)
    const olds = alternatives(oldDoc, before)
    const news = alternatives(newDoc, after)
    if (news.some((n) => kindOf(n) === 'any')) return
    const oldObjects = olds.filter((o) => kindOf(o) === 'object')
    const newObjects = news.filter((n) => kindOf(n) === 'object')
    const lost: Schema[] = []
    for (const o of olds) {
      const kind = kindOf(o)
      if (kind === 'const') {
        const covered = news.some((n) =>
          'const' in n ? n.const === o.const : n.type === typeof o.const,
        )
        if (!covered) lost.push(o)
      } else if (kind === 'array') {
        const n = news.find((a) => kindOf(a) === 'array')
        if (n) walk(o.items ?? {}, n.items ?? {}, `${path}[]`)
        else lost.push(o)
      } else if (kind !== 'object') {
        if (!news.some((n) => kindOf(n) === kind)) lost.push(o)
      }
    }
    if (lost.length) {
      add(
        path,
        'narrowed',
        true,
        `${shown(path)} was ${values(olds)} and is now ${values(news)}: files written before can hold ${values(lost)}, which the new type doesn't allow.`,
      )
    }
    const tag = discriminant(oldDoc, oldObjects)
    if (tag) {
      for (const o of oldObjects) {
        const [value] = constsOf(oldDoc, o, tag)
        const branch = join(path, `<${tag}=${value}>`)
        const n = newObjects.find((a) => constsOf(newDoc, a, tag).includes(value))
        if (n) object(o, n, branch)
        else {
          add(
            branch,
            'removed',
            true,
            `${shown(branch)}: files written before can hold this variant, and the new type has none with ${tag}: ${JSON.stringify(value)}.`,
          )
        }
      }
    } else if (oldObjects.length === 1 && newObjects.length >= 1) {
      const o = oldObjects[0] as Schema
      const shared = (a: Schema) =>
        Object.keys(a.properties ?? {}).filter((k) => k in (o.properties ?? {})).length
      const n = [...newObjects].sort((a, b) => shared(b) - shared(a))[0] as Schema
      object(o, n, path)
    } else if (oldObjects.length && !newObjects.length) {
      add(path, 'narrowed', true, `${shown(path)} was an object and is now ${values(news)}.`)
    }
    const gained = news.filter(
      (n) =>
        !olds.some((o) =>
          'const' in n ? 'const' in o && o.const === n.const : kindOf(o) === kindOf(n),
        ),
    )
    if (gained.length) {
      add(
        path,
        'widened',
        false,
        `${shown(path)} can now also be ${values(gained)}. An older reeval reading a new file sees a value it doesn't know, which the forward-compatibility test covers.`,
      )
    }
  }

  function object(o: Schema, n: Schema, path: string) {
    const oldProps = o.properties ?? {}
    const newProps = n.properties ?? {}
    for (const [name, schema] of Object.entries(oldProps)) {
      const p = join(path, name)
      const next = newProps[name]
      if (!next) {
        if (n.additionalProperties) walk(schema, n.additionalProperties, p)
        else {
          add(
            p,
            'removed',
            true,
            `${shown(p)} was removed or renamed. Files written before have it, and an older reeval reading a new file needs it.`,
          )
        }
        continue
      }
      walk(schema, next, p)
      if (!o.required?.includes(name) && n.required?.includes(name)) {
        if (defaults.has(p))
          add(
            p,
            'added-defaulted',
            false,
            `${shown(p)} is now required, and reads as its default in files without it.`,
          )
        else {
          add(
            p,
            'made-required',
            true,
            `${shown(p)} was optional and is now required: files written before may not have it.`,
          )
        }
      }
    }
    for (const name of Object.keys(newProps)) {
      if (name in oldProps) continue
      const p = join(path, name)
      if (!n.required?.includes(name)) {
        add(p, 'added-optional', false, `${shown(p)} was added, optional.`)
      } else if (defaults.has(p)) {
        add(
          p,
          'added-defaulted',
          false,
          `${shown(p)} was added, and reads as its default in files without it.`,
        )
      } else {
        add(
          p,
          'added-required',
          true,
          `${shown(p)} was added as a required field: files written before don't have it.`,
        )
      }
    }
    if (o.additionalProperties) {
      if (n.additionalProperties) walk(o.additionalProperties, n.additionalProperties, `${path}{}`)
      else if (Object.keys(newProps).length || !Object.keys(oldProps).length) {
        add(
          path,
          'narrowed',
          true,
          `${shown(path)} was a record of any keys and now has fixed ones.`,
        )
      }
    }
  }

  walk({ $ref: oldDoc.$ref }, { $ref: newDoc.$ref }, '')

  const from = oldDoc['x-schemaVersion']
  const to = newDoc['x-schemaVersion']
  if (from !== undefined && to !== undefined && from !== to) {
    if (to < from) {
      add('schemaVersion', 'version', true, `schemaVersion went down from ${from} to ${to}.`)
    } else {
      const missing: number[] = []
      for (let v = from; v < to; v++) if (!options.migrations.includes(v)) missing.push(v)
      if (missing.length) {
        add(
          'schemaVersion',
          'version',
          true,
          `schemaVersion went from ${from} to ${to}, and MIGRATIONS has no migration from version ${missing.join(', ')}.`,
        )
      } else {
        for (const c of changes) c.breaking = false
        add(
          'schemaVersion',
          'version',
          false,
          `schemaVersion went from ${from} to ${to}, with a migration from each older version.`,
        )
      }
    }
  }
  return changes
}

/**
 * Checks each read default names a required field of the shape: a default for a field that's gone,
 * optional or misspelled never runs.
 */
export function checkDefaults(doc: ShapeSchema, defaults: string[]): Change[] {
  const changes: Change[] = []
  for (const path of defaults) {
    const problem = findField(doc, path)
    if (problem) {
      changes.push({
        path,
        kind: 'default-unused',
        breaking: true,
        message: `READ_DEFAULTS has ${shown(path)}, but ${problem}. Fix the path, or drop the default if the field is gone.`,
      })
    }
  }
  return changes
}

function findField(doc: ShapeSchema, path: string): string | null {
  let current: Schema[] = [{ $ref: doc.$ref }]
  const segments = path.split('.')
  for (const [i, segment] of segments.entries()) {
    const last = i === segments.length - 1
    const objects = current
      .flatMap((s) => alternatives(doc, s))
      .filter((s) => kindOf(s) === 'object')
    const branch = /^<(\w+)=(.+)>$/.exec(segment)
    if (branch) {
      current = objects.filter((o) =>
        constsOf(doc, o, branch[1] as string)
          .map(String)
          .includes(branch[2] as string),
      )
      if (!current.length) return `no variant has ${branch[1]}: ${branch[2]}`
      continue
    }
    const [, name, suffix] = /^(.+?)(\[\]|\{\})?$/.exec(segment) ?? []
    const owners = objects.filter((o) => o.properties?.[name as string])
    if (!owners.length) return `\`${segments.slice(0, i + 1).join('.')}\` isn't a field`
    if (last) {
      if (suffix) return 'a default fills in a field, not the items of one'
      return owners.every((o) => o.required?.includes(name as string))
        ? null
        : 'the field is optional, so readers already handle it missing'
    }
    current = owners.flatMap((o) => {
      const field = o.properties?.[name as string] ?? {}
      const alts = alternatives(doc, field)
      if (suffix === '[]') return alts.flatMap((a) => (a.items ? [a.items] : []))
      if (suffix === '{}')
        return alts.flatMap((a) => (a.additionalProperties ? [a.additionalProperties] : []))
      return alts
    })
  }
  return null
}
