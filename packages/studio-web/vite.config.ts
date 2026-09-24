import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { studioDevData } from './dev-data.ts'

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss(), studioDevData()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      'evalsuite/view': fileURLToPath(new URL('../evalsuite/src/view/index.ts', import.meta.url)),
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
})
