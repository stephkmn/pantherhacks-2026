import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const ngrokUrl = env.ngrok_url || env.NGROK_URL || ''
  let ngrokHost
  let publicAppUrl = ''

  try {
    ngrokHost = ngrokUrl ? new URL(ngrokUrl).hostname : undefined
    publicAppUrl = ngrokUrl ? new URL(ngrokUrl).toString().replace(/\/$/, '') : ''
  } catch {
    ngrokHost = ngrokUrl || undefined
    publicAppUrl = ngrokUrl ? `https://${ngrokUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')}` : ''
  }

  return {
    plugins: [react()],
    define: {
      'import.meta.env.VITE_PUBLIC_APP_URL': JSON.stringify(publicAppUrl),
    },
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
