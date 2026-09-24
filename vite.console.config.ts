import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

/**
 * The console SPA: a separate app, built separately, served by a separate
 * worker (`worker/wrangler.console.toml`) — but the same root `node_modules`
 * and the same Tailwind/PostCSS config as the storefront, so the two stay one
 * visual product without a second dependency tree to keep in sync.
 */
export default defineConfig({
  root: 'console',
  plugins: [vue()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./console/src', import.meta.url)) },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
