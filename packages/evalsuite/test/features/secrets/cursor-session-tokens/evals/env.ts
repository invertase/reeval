import { defineEnvironment } from 'evalsuite'

export const plain = defineEnvironment('plain', {})

/** Where the Cursor CLI, run with the adapter's home, stores its session tokens. */
const AUTH =
  '~/.ai-sdk-harness/.harness-bootstrap/cursor/implementation/home/.config/cursor/auth.json'

/** The access token's signature, as stored in the container ('' before the CLI has one). */
export async function signature(readFile: (path: string) => Promise<string | null>) {
  const auth = JSON.parse((await readFile(AUTH)) ?? '{}') as { accessToken?: string }
  return auth.accessToken?.split('.')[2] ?? ''
}
