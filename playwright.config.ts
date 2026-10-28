import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, devices } from '@playwright/test'

const isolatedDirectory = mkdtempSync(join(tmpdir(), 'tod-browser-test-'))
const databasePath = join(isolatedDirectory, 'registry.sqlite')
// TOD_E2E_EXE=путь проверяет собранный исполняемый файл вместо `npm run dev`.
const executable = process.env.TOD_E2E_EXE

export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  // На агентах GitHub (особенно Windows) обращение к 127.0.0.1 изредка обрывается сетевой
  // ошибкой самого агента (net::ERR_NO_BUFFER_SPACE). Такой сценарий повторяется; прошедший со
  // второй попытки помечается в отчёте как «flaky», постоянная ошибка по-прежнему роняет запуск.
  retries: process.env.CI ? 2 : 0,
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
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
