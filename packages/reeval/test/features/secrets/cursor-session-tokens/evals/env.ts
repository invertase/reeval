import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

export const plain = defineEnvironment('plain', { sandbox })

type Exec = (command: string) => Promise<{ stdout: string }>

/**
 * The Cursor SDK keeps its session tokens in memory, so this does its key exchange again, from
 * the container, with the placeholder key its runner holds, and returns the access token's
 * signature as the container got it ('' when no runner is running, so there's no key).
 */
export async function signature(exec: Exec) {
  const key = `for p in /proc/[0-9]*; do tr '\\0' '\\n' < "$p/environ" 2>/dev/null | sed -n 's/^CURSOR_API_KEY=//p'; done | head -1`
  const r = await exec(
    `key=$(${key}); [ -n "$key" ] || exit 0; curl -sS -m 30 -X POST https://api2.cursor.sh/auth/exchange_user_api_key -H "Authorization: Bearer $key" -H 'Content-Type: application/json' -d '{}'`,
  )
  const auth = JSON.parse(r.stdout.trim() || '{}') as { accessToken?: string }
  return auth.accessToken?.split('.')[2] ?? ''
}
