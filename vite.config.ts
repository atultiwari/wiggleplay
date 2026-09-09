import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Set VITE_BASE_PATH=/wiggleplay/ when deploying to GitHub Pages project sites.
// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  base: process.env.VITE_BASE_PATH ?? '/',
  define: { __WIGGLE_BUILD__: JSON.stringify(process.env.WIGGLE_BUILD_VERSION ?? 'dev') },
  plugins: [react()],
  build: {
    sourcemap: mode !== 'production',
    chunkSizeWarningLimit: 1200,
  },
}))
