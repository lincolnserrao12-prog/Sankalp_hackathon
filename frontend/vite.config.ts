import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const wasmContentTypePlugin = (): Plugin => ({
  name: 'wasm-content-type',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = req.url || ''
      if (url.endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm')
      if (url.endsWith('.onnx') || url.endsWith('.onnx.data')) {
        res.setHeader('Content-Type', 'application/octet-stream')
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
      }
      if (url.endsWith('.wasm')) {
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
      }
      next()
    })
  },
  configurePreviewServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = req.url || ''
      if (url.endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm')
      if (url.endsWith('.onnx') || url.endsWith('.onnx.data')) {
        res.setHeader('Content-Type', 'application/octet-stream')
      }
      next()
    })
  },
})

export default defineConfig(() => ({
  plugins: [react(), wasmContentTypePlugin()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
  },
  build: {
    target: 'es2020',
    sourcemap: false,
    commonjsOptions: {
      strictRequires: true,
    },
  },
  optimizeDeps: {
    exclude: ['onnxruntime-web'],
  },
  worker: {
    format: 'es',
  },
}))
