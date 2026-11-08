import { createHash } from 'node:crypto'
import type { InstallStep } from '../types.ts'

/** The last path segment of `text`, with what an id can't hold replaced. */
export const idPart = (text: string) =>
  (text.split('/').at(-1) ?? text).replace(/[^A-Za-z0-9._:@-]+/g, '-')

/** `+` and a hash of the install steps, or nothing without any. */
export function installId(install: readonly InstallStep[] | undefined): string {
  if (!install?.length) return ''
  const key = JSON.stringify(
    install.map((step) =>
      typeof step === 'string' ? step : { run: step.run, timeout: step.timeout },
    ),
  )
  return `+${createHash('sha256').update(key).digest('hex').slice(0, 8)}`
}

/**
 * The cell id of an image recipe's sandbox: `name`, or `name:<image>` for an image, `from` or
 * Dockerfile, plus a hash of the install steps.
 */
export function recipeId(
  name: string,
  s: { image?: string; from?: string; dockerfile?: string; install?: readonly InstallStep[] },
): string {
  const install = installId(s.install)
  if (s.dockerfile) {
    const [file = '', dir = ''] = s.dockerfile.split(/[\\/]/).reverse()
    return `${name}:${idPart(file === 'Dockerfile' ? dir || file : file)}${install}`
  }
  const image = s.image ?? s.from
  return image ? `${name}:${idPart(image)}${install}` : `${name}${install}`
}
