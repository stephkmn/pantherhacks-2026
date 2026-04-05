import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const ngrokUrl = env.ngrok_url || env.NGROK_URL || ''
  let ngrokHost

  try {
    ngrokHost = ngrokUrl ? new URL(ngrokUrl).hostname : undefined
  } catch {
    ngrokHost = ngrokUrl || undefined
  }

  return {
    plugins: [react()],
    server: {
      port: 3000,
      allowedHosts: ngrokHost ? [ngrokHost] : undefined,
      proxy: {
        '/api': {
          target: 'http://localhost:8000',
          changeOrigin: true
        }
      }
    }
  }
})
