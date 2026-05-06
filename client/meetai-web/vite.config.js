import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'

const useHttps = process.env.VITE_AUTH_USE_HTTPS === 'true'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    https: useHttps ? {
      key: fs.readFileSync('./localhost-key.pem'),
      cert: fs.readFileSync('./localhost.pem'),
    } : false,
    port: 5173,
    host: true,
  }
})
