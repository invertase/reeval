// Generates a JSON Schema of each shape reeval persists and later reads back, from the TypeScript types
// that write and read them, with TypeScript 7's (unstable) checker API. Each named type's and
// property's TSDoc comment becomes its `description`.
import { join } from 'node:path'
import { API, SymbolFlags, TypeFlags } from 'typescript/unstable/sync'
import { PACKAGE_DIR, type PersistedShape, type PlanShape, SHAPES } from './shapes.ts'
import { withZodDefs } from './zod.ts'

export type Schema = {
  /** The TSDoc comment of the type alias, interface or property it was generated from. */
  description?: string
  $ref?: string
  type?: 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object'
  const?: string | number | boolean
  enum?: Array<string | number | boolean>
  anyOf?: Schema[]
  items?: Schema
  properties?: Record<string, Schema>
  required?: string[]
  additionalProperties?: Schema
}

export type ShapeSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema'
  $comment: string
  title: string
  /** The shape's `schemaVersion` literal, when it has one. */
  'x-schemaVersion'?: number
  $ref: string
  $defs: Record<string, Schema>
}

// biome-ignore lint/suspicious/noExplicitAny: the unstable API's classes aren't worth importing
type Any = any

const canonical = (s: Schema) => JSON.stringify(s)
const byCanonical = (a: Schema, b: Schema) => canonical(a).localeCompare(canonical(b))

class Generator {
  readonly defs = new Map<string, Schema>()
  readonly #named = new Map<number, string>()
  readonly #names = new Map<string, number>()

  readonly checker: Any
  readonly srcDir: string

  constructor(checker: Any, srcDir: string) {
    this.checker = checker
    this.srcDir = srcDir
  }

  /** A symbol's TSDoc comment on one line, for `description`. */
  #doc(symbol: Any): string | undefined {
    const text = this.checker.getDocumentationCommentOfSymbol(symbol).trim()
    return text ? text.replace(/\s*\n\s*/g, ' ') : undefined
  }

  /** The symbol a type is kept under in `$defs`: a type alias or interface declared in reeval's `src/`. */
  #symbolOf(type: Any): Any {
    const alias = type.getAliasSymbol()
    const symbol =
      alias && type.getAliasTypeArguments().length === 0
        ? alias
        : type.isClassOrInterface()
          ? type.getSymbol()
          : null
    if (!symbol) return null
    const path = String(symbol.declarations?.[0]?.path ?? '')
    if (!path.startsWith(this.srcDir)) return null
    return symbol
  }

  schema(type: Any): Schema {
    const symbol = this.#symbolOf(type)
    if (!symbol) return this.#inline(type)
    const name: string = symbol.name
    let key = this.#named.get(type.id)
    if (!key) {
      key = name
      for (let n = 2; this.#names.has(key) && this.#names.get(key) !== type.id; n++) {
        key = `${name}${n}`
      }
      this.#names.set(key, type.id)
      this.#named.set(type.id, key)
      this.defs.set(key, {})
      const description = this.#doc(symbol)
      this.defs.set(key, description ? { description, ...this.#inline(type) } : this.#inline(type))
    }
    return { $ref: `#/$defs/${key}` }
  }

  #inline(type: Any): Schema {
    const f = type.flags as number
    if (f & (TypeFlags.Any | TypeFlags.Unknown)) return {}
    if (f & TypeFlags.StringLiteral) return { const: type.value }
    if (f & TypeFlags.NumberLiteral) return { const: type.value }
    if (f & TypeFlags.BooleanLiteral) return { const: type.intrinsicName === 'true' }
    if (f & TypeFlags.String || f & TypeFlags.TemplateLiteral) return { type: 'string' }
    if (f & TypeFlags.Number) return { type: 'number' }
    if (f & TypeFlags.Boolean) return { type: 'boolean' }
    if (f & TypeFlags.Null) return { type: 'null' }
    if (type.isUnionType()) return this.#union(type.getTypes())
    if (this.checker.isArrayType(type)) {
      const [element] = this.checker.getTypeArguments(type)
      return { type: 'array', items: this.schema(element) }
    }
    if (this.checker.isTupleType(type)) {
      const elements = this.checker.getTypeArguments(type)
      return { type: 'array', items: this.#union(elements) }
    }
    if (type.isIntersectionType() || type.isObjectType()) return this.#object(type)
    throw new Error(
      `can't describe ${this.checker.typeToString(type)} (flags ${f}) as JSON: persisted types are JSON values`,
    )
  }

  #union(types: Any[]): Schema {
    const members = types.filter((t) => !(t.flags & (TypeFlags.Undefined | TypeFlags.Void)))
    const literals = members.filter((t) => t.flags & TypeFlags.BooleanLiteral)
    const rest = members.filter((t) => !(t.flags & TypeFlags.BooleanLiteral))
    const schemas = rest.map((t) => this.schema(t))
    if (literals.length === 2) schemas.push({ type: 'boolean' })
    else schemas.push(...literals.map((t) => this.#inline(t)))
    const consts = schemas.filter((s) => 'const' in s && Object.keys(s).length === 1)
    const others = schemas.filter((s) => !consts.includes(s)).sort(byCanonical)
    const values = consts.map((s) => s.const as string | number | boolean).sort()
    const all = values.length
      ? [...others, values.length === 1 ? { const: values[0] } : { enum: values }]
      : others
    const flat = all.flatMap((s) => (s.anyOf && Object.keys(s).length === 1 ? s.anyOf : [s]))
    return flat.length === 1 ? (flat[0] as Schema) : { anyOf: flat.sort(byCanonical) }
  }

  #object(type: Any): Schema {
    const properties: Record<string, Schema> = {}
    const required: string[] = []
    const props = [...this.checker.getPropertiesOfType(type)].sort((a: Any, b: Any) =>
      a.name.localeCompare(b.name),
    )
    for (const p of props) {
      const prop = this.checker.getTypeOfSymbol(p)
      // `environment?: never` forbids that key beside a compare object. It is not a JSON value.
      if ((prop.flags as number) & (TypeFlags.Undefined | TypeFlags.Never | TypeFlags.Void)) {
        continue
      }
      const description = this.#doc(p)
      properties[p.name] = description ? { description, ...this.schema(prop) } : this.schema(prop)
      if (!(p.flags & SymbolFlags.Optional)) required.push(p.name)
    }
    const schema: Schema = { type: 'object', properties, required }
    const index = this.checker
      .getIndexInfosOfType(type)
      .find((i: Any) => i.keyType.flags & TypeFlags.String)
    if (index) schema.additionalProperties = this.schema(index.valueType)
    return schema
  }
}

/** Every shape in `SHAPES`, as the code describes it today. */
export function generate(
  shapes: Array<PersistedShape | PlanShape> = SHAPES,
): Map<string, ShapeSchema> {
  const api = new API({ cwd: PACKAGE_DIR })
  try {
    const snapshot = api.updateSnapshot({ openProject: join(PACKAGE_DIR, 'tsconfig.json') })
    const project = snapshot.getProjects()[0]
    const checker = project.checker
    const out = new Map<string, ShapeSchema>()
    for (const shape of shapes) {
      const file = join(PACKAGE_DIR, shape.file)
      const source = project.program.getSourceFile(file)
      if (!source) throw new Error(`${shape.file} isn't in packages/reeval's tsconfig`)
      const symbol = checker.getSymbolAtLocation(source)?.getExports().get(shape.type)
      if (!symbol) throw new Error(`${shape.file} doesn't export ${shape.type}`)
      // Declarations carry the checker's canonical path: lower case on a case-insensitive file
      // system (macOS, Windows), with forward slashes.
      const gen = new Generator(checker, api.toPath(join(PACKAGE_DIR, 'src')))
      const root = gen.schema(checker.getDeclaredTypeOfSymbol(symbol))
      const doc: ShapeSchema = {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        $comment: `Generated from ${shape.type} in ${shape.file} by \`pnpm schema:update\`; don't edit. ${shape.where}.`,
        title: shape.type,
        $ref: root.$ref ?? '',
        // Persisted shapes stay generated from their types; plan shapes take the contract's defs.
        $defs: SHAPES.includes(shape as PersistedShape)
          ? Object.fromEntries([...gen.defs].sort(([a], [b]) => a.localeCompare(b)))
          : withZodDefs(Object.fromEntries(gen.defs)),
      }
      const field = 'versionField' in shape ? shape.versionField : undefined
      const version = field && resolve(doc, root).properties?.[field]
      if (field) {
        if (typeof version?.const !== 'number') {
          throw new Error(`${shape.type}.${field} isn't a number literal`)
        }
        doc['x-schemaVersion'] = version.const
      }
      out.set(shape.name, doc)
    }
    return out
  } finally {
    api.close()
  }
}

/** A `$ref` resolved against its document's `$defs`, followed until it isn't one. */
export function resolve(doc: Pick<ShapeSchema, '$defs'>, schema: Schema): Schema {
  let s = schema
  for (let seen = 0; s.$ref; seen++) {
    if (seen > 64) throw new Error(`${schema.$ref} refers to itself`)
    s = doc.$defs[s.$ref.replace('#/$defs/', '')] ?? {}
  }
  return s
}
