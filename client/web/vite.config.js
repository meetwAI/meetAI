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
      key: fs.readFileSync('./0.0.0.0-key.pem'),
      cert: fs.readFileSync('./0.0.0.0.pem'),
    } : false,
    port: 5173,
    host: true,
    allowedHosts: ['.cloudspaces.litng.ai']
  }
})
