/** Each browser gets a separate Playwright process, server lifecycle and fresh SQLite. */
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const browsers = ['chromium', 'firefox'] as const
export function browserRuns(args: string[]) {
  const selected: string[] = []
  const forwarded: string[] = []
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!
    if (value === '--project') selected.push(args[++index] ?? '')
    else if (value.startsWith('--project=')) selected.push(value.slice('--project='.length))
    else forwarded.push(value)
  }
  const names = selected.length ? [...new Set(selected)] : [...browsers]
  if (names.some((name) => !browsers.includes(name as (typeof browsers)[number])))
    throw new Error('Выберите --project=chromium или --project=firefox.')
  return names.map((browser) => ({ browser, args: forwarded }))
}

type Invoke = (
  command: string,
  args: string[],
  options: {
    cwd: string
    env: NodeJS.ProcessEnv
    stdio: 'inherit'
  },
) => { status: number | null; error?: Error }
export function runBrowserTests(args: string[], invoke: Invoke = spawnSync): number {
  const root = fileURLToPath(new URL('..', import.meta.url))
  let status = 0
  for (const run of browserRuns(args)) {
    const result = invoke(
      process.execPath,
      [
        resolve(root, 'node_modules/@playwright/test/cli.js'),
        'test',
        `--project=${run.browser}`,
        `--output=test-results/${run.browser}`,
        ...run.args,
      ],
      { cwd: root, env: { ...process.env, TOD_E2E_BROWSER: run.browser }, stdio: 'inherit' },
    )
    if (result.error) console.error(result.error.message)
    if (result.status !== 0) status = result.status ?? 1
  }
  return status
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = runBrowserTests(process.argv.slice(2))
