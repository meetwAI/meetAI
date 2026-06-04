import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import os from 'os'

const useHttps = process.env.VITE_AUTH_USE_HTTPS === 'true'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'log-hostname',
      configureServer(server) {
        server.httpServer?.on('listening', () => {
          setTimeout(() => {
            console.log(`  ➜  Hosted on: ${os.hostname()}`)
          }, 100)
        })
      }
    }
  ],
  server: {
    https: useHttps ? {
      key: fs.readFileSync('./localhost-key.pem'),
      cert: fs.readFileSync('./localhost.pem'),
    } : false,
    port: 5173,
    host: true,
  }
})
