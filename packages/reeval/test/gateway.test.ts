// The gateway resolver on a catalog with a second gateway, standing in for the ones reeval adds:
// fallback, pins and the plan's hint, as data.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { fallbackHint, type GatewayEntry, resolveGateway } from '../src/gateway/resolve.ts'
import { gatewayPart } from '../src/history/assemble.ts'
import type { HarnessDescriptor } from '../src/types.ts'

const WHERE = 'evaluate("e")'
const CATALOG: Record<string, GatewayEntry> = {
  direct: { cantServe: () => undefined },
  vercel: {
    cantServe: (h) => (h.kind === 'cursor' ? "Vercel AI Gateway can't run Cursor" : undefined),
  },
}
const cursor = { kind: 'cursor', model: 'composer-2.5' } as HarnessDescriptor
const codex = { kind: 'codex', model: 'gpt-5.4-mini' } as HarnessDescriptor
const pinned = (h: HarnessDescriptor, gateway: string) => ({ ...h, gateway }) as HarnessDescriptor
const list = (...kinds: string[]) => kinds.map((kind) => ({ kind }))
const resolve = (gateways: { kind: string }[], h: HarnessDescriptor) =>
  resolveGateway(gateways, h, WHERE, CATALOG)

describe('resolveGateway', () => {
  test('each harness takes the first gateway that can serve it', () => {
    assert.deepEqual(resolve(list('vercel', 'direct'), codex), { name: 'vercel', skipped: [] })
    assert.deepEqual(resolve(list('vercel', 'direct'), cursor), {
      name: 'direct',
      skipped: [{ gateway: 'vercel', why: "Vercel AI Gateway can't run Cursor" }],
    })
  })

  test('the plan hint names where a harness fell to, and why', () => {
    assert.equal(
      fallbackHint('cursor:composer-2.5', resolve(list('vercel', 'direct'), cursor)),
      "gateway: cursor:composer-2.5 → direct (vercel can't serve it: Vercel AI Gateway can't run Cursor)",
    )
  })

  test('nothing in the list serving it exits 2, naming each gateway tried', () => {
    assert.throws(() => resolve(list('vercel'), cursor), {
      name: 'UsageError',
      message:
        'evaluate("e") on cursor:composer-2.5: no gateway in the list can serve it (vercel: Vercel AI Gateway can\'t run Cursor). Add direct() to the end of gateway to use Cursor\'s own key.',
    })
  })

  test('a pin skips the fallback, and must be listed and able to serve', () => {
    assert.deepEqual(resolve(list('vercel', 'direct'), pinned(codex, 'direct')), {
      name: 'direct',
      skipped: [],
    })
    assert.throws(() => resolve(list('direct'), pinned(codex, 'vercel')), {
      message:
        "evaluate(\"e\") on codex:gpt-5.4-mini: it pins gateway 'vercel', which isn't in the gateway list (direct). Add vercel() to gateway, or pin one that's there.",
    })
    assert.throws(() => resolve(list('vercel', 'direct'), pinned(cursor, 'vercel')), {
      message:
        "evaluate(\"e\") on cursor:composer-2.5: it pins gateway 'vercel', which can't serve it (Vercel AI Gateway can't run Cursor). A pin never falls back; pin another gateway, or remove the pin to take the first in the list that can.",
    })
  })

  test('only a gateway other than direct joins the fingerprint', () => {
    assert.deepEqual(gatewayPart(undefined), {})
    assert.deepEqual(gatewayPart({ name: 'direct', skipped: [] }), {})
    assert.deepEqual(
      gatewayPart({ name: 'vercel' as 'direct', skipped: [] }),
      { gateway: 'vercel' },
      'a new route is a new measurement',
    )
  })
})
