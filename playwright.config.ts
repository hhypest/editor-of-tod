import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, devices } from '@playwright/test'

const isolatedDirectory = mkdtempSync(join(tmpdir(), 'tod-browser-test-'))

export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:5173' },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: false,
    timeout: 60_000,
    env: { TOD_DATABASE_PATH: join(isolatedDirectory, 'registry.sqlite') },
  },
})
