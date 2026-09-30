import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'

/** Сведения о сборке для файла диагностики: версия пакета, коммит и время сборки. */
function buildInfo(): { version: string; commit: string; builtAt: string } {
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
  let commit = 'unknown'
  try {
    commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    // Сборка вне репозитория Git.
  }
  return { version: String(pkg.version), commit, builtAt: new Date().toISOString() }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue(), vueDevTools()],
  define: { __APP_BUILD__: JSON.stringify(buildInfo()) },
  server: {
    host: '127.0.0.1',
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:4100', changeOrigin: true } },
  },
  preview: {
    host: '127.0.0.1',
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:4100', changeOrigin: true } },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
