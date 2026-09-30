import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'

import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'
import {
  licenseProblems,
  nodeLicense,
  packagesFromModules,
  renderNotices,
  serverModules,
  summary,
} from './scripts/third-party-licenses.ts'

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

/**
 * Сведения о сторонних компонентах для раздела «О программе» и файла рядом с exe: пакеты,
 * вошедшие в сборку интерфейса, и пакеты локального сервера (сборка esbuild, как у exe).
 * Пакет с лицензией вне разрешённого списка или без текста лицензии останавливает сборку.
 */
function thirdPartyLicenses(): Plugin {
  const root = fileURLToPath(new URL('.', import.meta.url))
  return {
    name: 'third-party-licenses',
    apply: 'build',
    async generateBundle(_options, bundle) {
      const modules = new Set<string>()
      for (const output of Object.values(bundle)) {
        if (output.type === 'chunk') for (const id of output.moduleIds) modules.add(id)
      }
      const groups = [
        { title: 'Интерфейс (работает в браузере)', packages: packagesFromModules(modules) },
        { title: 'Локальный сервер', packages: packagesFromModules(await serverModules(root)) },
      ]
      const problems = licenseProblems(groups.flatMap((group) => group.packages))
      if (problems.length) this.error(`Лицензии сторонних компонентов:\n${problems.join('\n')}`)
      const node = { version: process.versions.node, text: nodeLicense() }
      this.emitFile({
        type: 'asset',
        fileName: 'legal/THIRD_PARTY_LICENSES.txt',
        source: renderNotices({ groups, node }),
      })
      this.emitFile({
        type: 'asset',
        fileName: 'legal/third-party.json',
        source: JSON.stringify(summary(groups, node)),
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue(), vueDevTools(), thirdPartyLicenses()],
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
