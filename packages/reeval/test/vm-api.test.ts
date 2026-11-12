// `reeval/internal/vm-api` and its `/boat` and `/daytona` subpaths, as built: the adapters over their
// SDKs against the fake APIs (support/boat.ts, support/daytona.ts), and none of the subpaths loads
// an SDK or a Node built-in: the caller builds the SDK client.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { BoatApi, Configuration } from '@boatdev/sdk'
import { Daytona } from '@daytona/sdk'
import { removeUntilGone, type VmApi, waitReady } from 'reeval/internal/vm-api'
import { boatApi } from 'reeval/internal/vm-api/boat'
import { daytonaApi } from 'reeval/internal/vm-api/daytona'
import { pkgRoot } from './helpers.ts'
import { type FakeBoat, fakeBoat, unreachableMachines } from './support/boat.ts'
import { type FakeDaytona, fakeDaytona } from './support/daytona.ts'

let boat: FakeBoat
let daytona: FakeDaytona
before(async () => {
  boat = await fakeBoat(unreachableMachines, { maxActive: 4 })
  daytona = await fakeDaytona(unreachableMachines)
})
after(async () => {
  await boat.close()
  await daytona.close()
})

const boatClient = (accessToken: string) =>
  boatApi(new BoatApi(new Configuration({ accessToken, basePath: boat.url })))
const daytonaClient = (apiKey: string) =>
  new Daytona({ apiKey, apiUrl: daytona.url, useDeprecatedPolling: true })

const providers: Array<[string, () => VmApi, () => string[]]> = [
  ['Boat', () => boatClient(boat.key), () => boat.live()],
  [
    'Daytona',
    () => daytonaApi(daytonaClient(daytona.key), { startTimeoutSeconds: 10 }),
    () => daytona.live(),
  ],
]

for (const [name, client, live] of providers) {
  describe(`${name} through its SDK`, () => {
    test('starts a machine, waits for it, gives SSH access, lists it and deletes it', async () => {
      const api = client()
      const made = await api.create({
        name: `reeval-vmapi-${name.toLowerCase()}`,
        size: 'small',
        labels: { 'reeval.test': 'vm-api' },
        ttlSeconds: 600,
        idempotencyKey: `reeval-vmapi-${name.toLowerCase()}`,
      })
      assert.equal(made.state === 'dead', false)
      const ready = await waitReady(api, made.id, { timeoutMs: 10_000, pollMs: 20 })
      assert.equal(ready.state, 'ready')
      const ssh = await api.sshAccess(made.id, { publicKey: 'ssh-ed25519 AAAA test', minutes: 10 })
      assert.ok(ssh.routes.length > 0)
      assert.equal(ssh.auth, api.capabilities.sshHostKey ? 'key' : 'token')
      assert.equal(!!ssh.hostKey, api.capabilities.sshHostKey)
      await api.setTtl(made.id, 900)
      const listed: string[] = []
      for await (const vm of api.list({
        namePrefix: 'reeval-vmapi-',
        labels: { 'reeval.test': 'vm-api' },
      })) {
        listed.push(vm.id)
      }
      assert.deepEqual(listed, [made.id])
      assert.equal(await removeUntilGone(api, made.id, { pollMs: 20 }), true)
      assert.equal(await api.get(made.id), null)
      assert.deepEqual(live(), [])
    })

    test('a refused key is an auth error that names neither key', async () => {
      const api = name === 'Boat' ? boatClient('wrong') : daytonaApi(daytonaClient('wrong'))
      const error = await api.get('x').catch((e: unknown) => e)
      assert.equal((error as { kind?: string }).kind, 'auth')
      assert.doesNotMatch(String((error as Error).message), /wrong|boat_test|dtn_test/)
    })
  })
}

for (const entry of ['vm-api', 'vm-api/boat', 'vm-api/daytona']) {
  test(`reeval/internal/${entry} imports no Node built-in and no other package`, () => {
    const seen = new Set<string>()
    const visit = (file: string) => {
      if (seen.has(file)) return
      seen.add(file)
      const source = readFileSync(file, 'utf8')
      for (const m of source.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+)['"]/g)) {
        const spec = m[1] as string
        assert.ok(spec.startsWith('.'), `${file} imports ${spec}`)
        visit(join(dirname(file), spec))
      }
    }
    visit(join(pkgRoot, 'dist', 'internal', `${entry}.js`))
    assert.ok(seen.size >= 1)
  })
}
