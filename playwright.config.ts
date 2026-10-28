import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, devices } from '@playwright/test'

const isolatedDirectory = mkdtempSync(join(tmpdir(), 'tod-browser-test-'))
const databasePath = join(isolatedDirectory, 'registry.sqlite')
// TOD_E2E_EXE=путь проверяет собранный исполняемый файл вместо `npm run dev`.
const executable = process.env.TOD_E2E_EXE
// npm test:e2e runs the browsers in separate processes, each with the database above.
// Direct Playwright defaults to Chromium; an explicit single --project selects Firefox.
const arguments_ = process.argv.slice(2)
const selections = arguments_.flatMap((arg, index) =>
  arg === '--project'
    ? [arguments_[index + 1] ?? '']
    : arg.startsWith('--project=')
      ? [arg.slice(10)]
      : [],
)
if (selections.length > 1) throw new Error('Для нескольких браузеров используйте npm run test:e2e.')
const browser = process.env.TOD_E2E_BROWSER ?? selections[0] ?? 'chromium'
if (browser !== 'chromium' && browser !== 'firefox')
  throw new Error(`Неизвестный браузер: ${browser}`)

export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  // На агентах GitHub (особенно Windows) обращение к 127.0.0.1 изредка обрывается сетевой
  // ошибкой самого агента (net::ERR_NO_BUFFER_SPACE). Такой сценарий повторяется; прошедший со
  // второй попытки помечается в отчёте как «flaky», постоянная ошибка по-прежнему роняет запуск.
  retries: process.env.CI ? 2 : 0,
  projects: [
    {
      name: browser,
      use: { ...devices[browser === 'chromium' ? 'Desktop Chrome' : 'Desktop Firefox'] },
    },
  ],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    baseURL: executable ? 'http://127.0.0.1:4100' : 'http://127.0.0.1:5173',
  },
  webServer: executable
    ? {
        command: `"${executable}" --no-browser`,
        url: 'http://127.0.0.1:4100/api/status',
        reuseExistingServer: false,
        timeout: 60_000,
        env: { TOD_DATABASE_PATH: databasePath },
      }
    : {
        command: 'npm run dev',
        url: 'http://127.0.0.1:5173',
        reuseExistingServer: false,
        timeout: 60_000,
        env: { TOD_DATABASE_PATH: databasePath },
      },
})
