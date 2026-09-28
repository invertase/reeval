import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { bundledLicenses, cssImports } from '../../scripts/third-party.mjs'
import { studioDevData } from './dev-data.ts'

const src = (path: string) => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  base: './',
  plugins: [
    react(),
    tailwindcss(),
    studioDevData(),
    // For reeval's THIRD_PARTY_NOTICES.md; its build leaves this file out of
    // dist/studio-app.
    bundledLicenses('dist/studio-app', (packages) =>
      writeFileSync(
        src('./dist/third-party.json'),
        JSON.stringify([...packages, ...cssImports(src('./src/index.css'), 'dist/studio-app')]),
      ),
    ),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      'reeval/view': fileURLToPath(new URL('../reeval/src/view/index.ts', import.meta.url)),
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
})
