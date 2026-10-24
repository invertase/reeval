/**
 * The prebuilt studio web app (packages/studio-web/dist), by path: `index.html`, `assets/…`.
 * Empty in the source; the build (tsdown.config.mjs) replaces this module with the app's files,
 * so the npm package and a compiled reeval serve the same bytes with no files on disk.
 */
export const APP_FILES: Record<string, { utf8: string } | { base64: string }> = {}
