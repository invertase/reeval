import { createHash } from 'node:crypto'

export type AppFile = { body: Buffer; etag: string }

/** The studio web app's files by path (`index.html`, `assets/index-<hash>.js`, …). */
export type StudioAppFiles = ReadonlyMap<string, AppFile>

/** An app from each file's contents, by path. */
export function appFiles(files: Record<string, string | Uint8Array>): StudioAppFiles {
  return new Map(
    Object.entries(files).map(([path, contents]) => {
      const body = Buffer.from(contents)
      const etag = `"${createHash('sha256').update(body).digest('base64url').slice(0, 22)}"`
      return [path, { body, etag }]
    }),
  )
}

let loaded: Promise<StudioAppFiles> | undefined

/** The app the build embeds, imported only by the studio commands: it's about 740 KB of code. */
export function embeddedApp(): Promise<StudioAppFiles> {
  loaded ??= import('./app-files.ts').then(({ APP_FILES }) =>
    appFiles(
      Object.fromEntries(
        Object.entries(APP_FILES).map(([path, file]) => [
          path,
          'utf8' in file ? file.utf8 : Buffer.from(file.base64, 'base64'),
        ]),
      ),
    ),
  )
  return loaded
}
