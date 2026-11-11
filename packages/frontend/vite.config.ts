import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  const target = env.VITE_API_URL || 'http://localhost:3000'

  return {
    plugins: [vue()],
    server: {
      proxy: {
        '/auth': { target, changeOrigin: true },
        '/settings': {
          target,
          changeOrigin: true,
          // Keep the Settings page as a client-side route; proxy API reads only.
          bypass(req) {
            if (req.headers.accept?.includes('text/html')) return '/index.html'
          },
        },
      },
    },
  }
})
