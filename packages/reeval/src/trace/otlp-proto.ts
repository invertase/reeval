// OTLP's protobuf encoding of the requests `otlp.ts` builds in OTLP's JSON mapping: the messages and
// fields reeval sends, by their numbers in opentelemetry-proto, and nothing else. Plain bytes: no
// protobuf library.

type Kind =
  | 'string'
  | 'bool'
  | 'enum'
  | 'int64'
  | 'fixed64'
  | 'sfixed64'
  | 'double'
  // A trace or span id: hex in the JSON mapping, bytes on the wire.
  | 'hex'

type Field = {
  no: number
  kind: Kind | Message
  repeated?: boolean
  // A oneof member: written even when it holds its type's default.
  always?: boolean
}
type Message = { [name: string]: Field }

const AnyValue: Message = {
  stringValue: { no: 1, kind: 'string', always: true },
  boolValue: { no: 2, kind: 'bool', always: true },
  intValue: { no: 3, kind: 'int64', always: true },
  doubleValue: { no: 4, kind: 'double', always: true },
}
const KeyValue: Message = { key: { no: 1, kind: 'string' }, value: { no: 2, kind: AnyValue } }
const attributes = (no: number): Field => ({ no, kind: KeyValue, repeated: true })

const Resource: Message = { attributes: attributes(1) }
const Scope: Message = { name: { no: 1, kind: 'string' }, version: { no: 2, kind: 'string' } }

const Span: Message = {
  traceId: { no: 1, kind: 'hex' },
  spanId: { no: 2, kind: 'hex' },
  parentSpanId: { no: 4, kind: 'hex' },
  name: { no: 5, kind: 'string' },
  kind: { no: 6, kind: 'enum' },
  startTimeUnixNano: { no: 7, kind: 'fixed64' },
  endTimeUnixNano: { no: 8, kind: 'fixed64' },
  attributes: attributes(9),
  links: {
    no: 13,
    kind: { traceId: { no: 1, kind: 'hex' }, spanId: { no: 2, kind: 'hex' } },
    repeated: true,
  },
  status: { no: 15, kind: { message: { no: 2, kind: 'string' }, code: { no: 3, kind: 'enum' } } },
}

const LogRecord: Message = {
  timeUnixNano: { no: 1, kind: 'fixed64' },
  severityNumber: { no: 2, kind: 'enum' },
  severityText: { no: 3, kind: 'string' },
  body: { no: 5, kind: AnyValue },
  attributes: attributes(6),
  traceId: { no: 9, kind: 'hex' },
  spanId: { no: 10, kind: 'hex' },
  observedTimeUnixNano: { no: 11, kind: 'fixed64' },
}

const NumberDataPoint: Message = {
  startTimeUnixNano: { no: 2, kind: 'fixed64' },
  timeUnixNano: { no: 3, kind: 'fixed64' },
  asDouble: { no: 4, kind: 'double', always: true },
  asInt: { no: 6, kind: 'sfixed64', always: true },
  attributes: attributes(7),
}
const dataPoints: Field = { no: 1, kind: NumberDataPoint, repeated: true }
const Metric: Message = {
  name: { no: 1, kind: 'string' },
  description: { no: 2, kind: 'string' },
  unit: { no: 3, kind: 'string' },
  gauge: { no: 5, kind: { dataPoints } },
  sum: {
    no: 7,
    kind: {
      dataPoints,
      aggregationTemporality: { no: 2, kind: 'enum' },
      isMonotonic: { no: 3, kind: 'bool' },
    },
  },
}

/** `resource`, `scope<Items>` and `<items>` under it: every signal's request has this shape. */
const request = (resources: string, scopes: string, items: string, item: Message): Message => ({
  [resources]: {
    no: 1,
    repeated: true,
    kind: {
      resource: { no: 1, kind: Resource },
      [scopes]: {
        no: 2,
        repeated: true,
        kind: { scope: { no: 1, kind: Scope }, [items]: { no: 2, kind: item, repeated: true } },
      },
    },
  },
})

export const TRACES_REQUEST = request('resourceSpans', 'scopeSpans', 'spans', Span)
export const LOGS_REQUEST = request('resourceLogs', 'scopeLogs', 'logRecords', LogRecord)
export const METRICS_REQUEST = request('resourceMetrics', 'scopeMetrics', 'metrics', Metric)

const utf8 = new TextEncoder()

class Writer {
  #buf = new Uint8Array(256)
  #len = 0

  #room(n: number) {
    if (this.#len + n <= this.#buf.length) return
    const next = new Uint8Array(Math.max(this.#buf.length * 2, this.#len + n))
    next.set(this.#buf.subarray(0, this.#len))
    this.#buf = next
  }

  byte(b: number) {
    this.#room(1)
    this.#buf[this.#len++] = b
  }

  varint(v: bigint) {
    let n = BigInt.asUintN(64, v)
    while (n > 0x7fn) {
      this.byte(Number(n & 0x7fn) | 0x80)
      n >>= 7n
    }
    this.byte(Number(n))
  }

  bytes(b: Uint8Array) {
    this.#room(b.length)
    this.#buf.set(b, this.#len)
    this.#len += b.length
  }

  fixed64(v: bigint) {
    const b = new Uint8Array(8)
    new DataView(b.buffer).setBigUint64(0, BigInt.asUintN(64, v), true)
    this.bytes(b)
  }

  double(v: number) {
    const b = new Uint8Array(8)
    new DataView(b.buffer).setFloat64(0, v, true)
    this.bytes(b)
  }

  done(): Uint8Array {
    return this.#buf.slice(0, this.#len)
  }
}

const VARINT = 0
const I64 = 1
const LEN = 2

const hexBytes = (hex: string) => {
  const out = new Uint8Array(hex.length >> 1)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

const isDefault = (value: unknown) =>
  value === '' || value === 0 || value === false || value === '0' || value === 0n

function writeField(w: Writer, field: Field, value: unknown) {
  const { no, kind } = field
  if (typeof kind === 'object') {
    const body = encodeMessage(kind, value as Record<string, unknown>)
    w.varint(BigInt((no << 3) | LEN))
    w.varint(BigInt(body.length))
    w.bytes(body)
    return
  }
  if (!field.always && isDefault(value)) return
  switch (kind) {
    case 'string':
    case 'hex': {
      const body = kind === 'hex' ? hexBytes(value as string) : utf8.encode(value as string)
      w.varint(BigInt((no << 3) | LEN))
      w.varint(BigInt(body.length))
      w.bytes(body)
      return
    }
    case 'bool':
      w.varint(BigInt((no << 3) | VARINT))
      w.varint(value ? 1n : 0n)
      return
    case 'enum':
    case 'int64':
      w.varint(BigInt((no << 3) | VARINT))
      w.varint(BigInt(value as string | number))
      return
    case 'fixed64':
    case 'sfixed64':
      w.varint(BigInt((no << 3) | I64))
      w.fixed64(BigInt(value as string | number))
      return
    case 'double':
      w.varint(BigInt((no << 3) | I64))
      w.double(value as number)
      return
  }
}

/** `value`, in OTLP's JSON mapping, as the protobuf message `message` describes. */
export function encodeMessage(message: Message, value: Record<string, unknown>): Uint8Array {
  const w = new Writer()
  for (const [name, field] of Object.entries(message)) {
    const v = value[name]
    if (v === undefined || v === null) continue
    if (field.repeated) for (const item of v as unknown[]) writeField(w, field, item)
    else writeField(w, field, v)
  }
  return w.done()
}
