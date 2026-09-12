import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Worker uses ES module format so it can `import` the wasm glue.
export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  server: { port: 5173, strictPort: false },
})
