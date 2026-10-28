// Generates a JSON Schema of each shape reeval persists and later reads back, from the TypeScript types
// that write and read them, with TypeScript 7's (unstable) checker API. Each named type's and
// property's TSDoc comment becomes its `description`, in the contract's Zod-owned defs too.
import { join } from 'node:path'
import { API, SymbolFlags, TypeFlags } from 'typescript/unstable/sync'
import type { z } from 'zod'
import { CONTRACT_REFS, CONTRACT_SCHEMAS } from '../../src/contract/index.ts'
import { PACKAGE_DIR, type PersistedShape, PLAN_SHAPES, type PlanShape, SHAPES } from './shapes.ts'
import { checkContractCoverage, type TypeDocs, withZodDefs, zodDefs } from './zod.ts'

type SchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'array' | 'object'

export type Schema = {
  /** The TSDoc comment of the type alias, interface or property it was generated from. */
  description?: string
  $ref?: string
  /** A list where Zod writes a nullable value, `['string', 'null']`. */
  type?: SchemaType | SchemaType[]
  const?: string | number | boolean
  enum?: Array<string | number | boolean>
  anyOf?: Schema[]
  /** Zod's discriminated unions; the types' own unions are `anyOf`. */
  oneOf?: Schema[]
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

/**
 * Types whose JSON shape is another type's: an at-least-one-input rule that only the compiler and
 * the Zod refinement hold, which a JSON Schema object can't say without listing every variant.
 */
const SHAPE_OF: Record<string, string> = {
  Question: 'QuestionFields',
  JudgeCallOptions: 'JudgeCallFields',
}

const canonical = (s: Schema) => JSON.stringify(s)
const byCanonical = (a: Schema, b: Schema) => canonical(a).localeCompare(canonical(b))

class Generator {
  readonly defs = new Map<string, Schema>()
  readonly #named = new Map<number, string>()
  readonly #names = new Map<string, number>()

  readonly checker: Any
  readonly srcDir: string
  readonly typeNamed: (name: string) => Any

  constructor(checker: Any, srcDir: string, typeNamed: (name: string) => Any) {
    this.checker = checker
    this.srcDir = srcDir
    this.typeNamed = typeNamed
  }

  /** The type whose properties `symbol`'s def lists: its own, or its `SHAPE_OF` type's. */
  #shapeOf(symbol: Any, type: Any): Any {
    const other = SHAPE_OF[symbol.name]
    return other ? this.checker.getDeclaredTypeOfSymbol(this.typeNamed(other)) : type
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

  /** A type alias's or interface's own def, even where `schema` would inline it (a union alias). */
  def(symbol: Any): Schema {
    const description = this.#doc(symbol)
    const inline = this.#inline(this.#shapeOf(symbol, this.checker.getDeclaredTypeOfSymbol(symbol)))
    return description ? { description, ...inline } : inline
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
      const inline = this.#inline(this.#shapeOf(symbol, type))
      this.defs.set(key, description ? { description, ...inline } : inline)
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

type Project = {
  checker: Any
  srcDir: string
  exported: (file: string, name: string) => Any
}

const typeNamedIn = (project: Project) => (name: string) => {
  const symbol = project.exported('src/types.ts', name)
  if (!symbol) throw new Error(`src/types.ts doesn't export ${name}`)
  return symbol
}

/** Runs `use` on packages/reeval's program, through TypeScript's API. */
function withProject<T>(use: (project: Project) => T): T {
  const api = new API({ cwd: PACKAGE_DIR })
  try {
    const snapshot = api.updateSnapshot({ openProject: join(PACKAGE_DIR, 'tsconfig.json') })
    const project = snapshot.getProjects()[0]
    const checker = project.checker
    return use({
      checker,
      // Declarations carry the checker's canonical path: lower case on a case-insensitive file
      // system (macOS, Windows), with forward slashes.
      srcDir: api.toPath(join(PACKAGE_DIR, 'src')),
      exported: (file, name) => {
        const source = project.program.getSourceFile(join(PACKAGE_DIR, file))
        if (!source) throw new Error(`${file} isn't in packages/reeval's tsconfig`)
        return checker.getSymbolAtLocation(source)?.getExports().get(name)
      },
    })
  } finally {
    api.close()
  }
}

/** Every shape in `SHAPES`, as the code describes it today. */
export function generate(
  shapes: Array<PersistedShape | PlanShape> = SHAPES,
): Map<string, ShapeSchema> {
  return withProject((project) => {
    const { checker, srcDir, exported } = project
    const out = new Map<string, ShapeSchema>()
    const typed = new Set<string>()
    let owned: Record<string, Schema> | undefined
    for (const shape of shapes) {
      const symbol = exported(shape.file, shape.type)
      if (!symbol) throw new Error(`${shape.file} doesn't export ${shape.type}`)
      const gen = new Generator(checker, srcDir, typeNamedIn(project))
      const root = gen.schema(checker.getDeclaredTypeOfSymbol(symbol))
      const plan = !SHAPES.includes(shape as PersistedShape)
      if (plan) for (const name of gen.defs.keys()) typed.add(name)
      if (plan) owned ??= zodDefs(CONTRACT_SCHEMAS, CONTRACT_REFS, contractDocs(project))
      const doc: ShapeSchema = {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        $comment: `Generated from ${shape.type} in ${shape.file} by \`pnpm schema:update\`; don't edit. ${shape.where}.`,
        title: shape.type,
        $ref: root.$ref ?? '',
        // Persisted shapes stay generated from their types; plan shapes take the contract's defs.
        $defs: plan
          ? withZodDefs(Object.fromEntries(gen.defs), owned)
          : Object.fromEntries([...gen.defs].sort(([a], [b]) => a.localeCompare(b))),
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
    if (PLAN_SHAPES.every((shape) => shapes.includes(shape))) checkContractCoverage(typed)
    return out
  })
}

/** Where the hand-written types whose TSDoc describes a Zod schema are exported. */
const DOC_TYPE_FILES = ['src/types.ts', 'src/declaration.ts']

function typeDefsIn(project: Project, types: Record<string, string>): Record<string, Schema> {
  const gen = new Generator(project.checker, project.srcDir, typeNamedIn(project))
  return Object.fromEntries(
    Object.entries(types).map(([key, type]) => {
      const symbol = DOC_TYPE_FILES.map((file) => project.exported(file, type)).find(Boolean)
      if (!symbol) throw new Error(`none of ${DOC_TYPE_FILES.join(', ')} exports a type ${type}`)
      return [key, gen.def(symbol)]
    }),
  )
}

/**
 * The def generated from each type in `types` (by the key it's given there), TSDoc included,
 * even where the type generator would inline it. A type is looked up in `DOC_TYPE_FILES`.
 */
export const typeDefs = (types: Record<string, string>) =>
  withProject((project) => typeDefsIn(project, types))

/** Each contract schema with the def generated from its hand-written type of the same name. */
function contractDocs(project: Project): TypeDocs[] {
  const names = Object.keys(CONTRACT_SCHEMAS)
  const typed = typeDefsIn(project, Object.fromEntries(names.map((name) => [name, name])))
  return names.map((name) => ({
    name,
    schema: CONTRACT_SCHEMAS[name] as z.ZodType,
    typed: typed[name] as Schema,
  }))
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
