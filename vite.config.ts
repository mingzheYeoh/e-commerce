import { defineConfig, type Plugin } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

/**
 * Drops the ONNX Runtime WASM binary Vite emits but the app never loads.
 *
 * onnxruntime-web references its binary with `new URL(..., import.meta.url)`,
 * so Vite resolves and copies it — 26.8 MB of it. transformers.js then
 * overwrites `wasm.wasmPaths` with a jsDelivr URL on every browser init, so the
 * emitted copy is dead weight that also happens to sit just over Cloudflare
 * Pages' 25 MiB per-file limit, which is how it was found.
 *
 * If a future version starts honouring the local path, semantic search reports
 * `unavailable` and the keyword engine still answers — a slower search, not a
 * blank page.
 */
function dropOrtWasm(): Plugin {
  return {
    name: 'drop-ort-wasm',
    apply: 'build',
    generateBundle(_options, bundle) {
      for (const file of Object.keys(bundle)) {
        if (/ort-wasm.*\.wasm$/.test(file)) delete bundle[file]
      }
    },
  }
}

export default defineConfig({
  plugins: [vue(), dropOrtWasm()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'jsdom',
    // The worker's order validation is money code and gets tested here too,
    // rather than in a second runner nobody remembers to run.
    include: ['src/**/*.spec.ts', 'worker/src/**/*.spec.ts', 'console/src/**/*.spec.ts'],
  },
})