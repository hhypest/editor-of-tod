// Точка входа исполняемого файла (Node.js single executable application).
// Запускает локальный API и интерфейс на 127.0.0.1 и открывает браузер.
// Без упаковки запускается командой `npm run desktop` и берёт интерфейс из `dist/`.
import { exec } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { databaseIdentity, startDesktopServer } from './desktop-instance.ts'
import { getAsset, isSea } from 'node:sea'
import { resolveDataDirectory, resolvePort } from './app-paths.ts'
import { DiagnosticsLog } from './diagnostics.ts'
import { createRegistryServer, DEFAULT_PORT, type StaticFiles } from './index.ts'
import { RegistryStore } from './store.ts'

declare const __TOD_VERSION__: string | undefined

const version = typeof __TOD_VERSION__ === 'string' ? __TOD_VERSION__ : 'dev'
const noBrowser = Boolean(process.env.TOD_NO_BROWSER) || process.argv.includes('--no-browser')

function seaFiles(): StaticFiles {
  return async (filename) => Buffer.from(getAsset(`dist/${filename}`))
}

function openBrowser(url: string): void {
  if (noBrowser) return
  const command =
    process.platform === 'win32'
      ? `start "" "${url}"`
      : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`
  exec(command, () => undefined)
}

/** Показывает ошибку и не даёт окну консоли закрыться сразу после двойного щелчка. */
function fail(message: string): void {
  console.error(`\n${message}`)
  process.exitCode = 1
  if (process.platform === 'win32' && process.stdin.isTTY) {
    console.error('Нажмите Enter, чтобы закрыть окно.')
    process.stdin.resume()
    process.stdin.once('data', () => process.exit(1))
  }
}

async function main(): Promise<void> {
  const preferredPort = resolvePort(process.env.TOD_PORT, DEFAULT_PORT)
  console.log(`Редактор схем ОДД ${version}`)

  process.umask(0o077)
  let databasePath = process.env.TOD_DATABASE_PATH
  let portableNote = ''
  if (!databasePath) {
    const location = resolveDataDirectory(dirname(process.execPath))
    databasePath = join(location.directory, 'registry.sqlite')
    if (!location.portable) {
      portableNote =
        'Папка программы недоступна для записи, данные хранятся в профиле пользователя.'
    }
  }

  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 })
  const databaseId = databaseIdentity(databasePath)
  const state: { store?: RegistryStore; diagnostics?: DiagnosticsLog } = {}
  const result = await startDesktopServer(preferredPort, databaseId, (port) => {
    state.store ??= new RegistryStore(databasePath)
    // Повторный запуск не должен переписывать журнал работающего экземпляра.
    state.diagnostics ??= new DiagnosticsLog(join(dirname(databasePath), 'diagnostics.jsonl'), {
      version,
      mode: isSea() ? 'exe' : 'npm run desktop',
    })
    return createRegistryServer(
      state.store,
      port,
      isSea() ? seaFiles() : undefined,
      state.diagnostics,
      databaseId,
    )
  }).catch((error: unknown) => {
    state.store?.close()
    throw error
  })
  const { port } = result
  const url = `http://127.0.0.1:${port}/`
  if (result.reused) {
    state.store?.close()
    console.log(`Редактор с этой базой уже запущен: ${url}\nДанные: ${databasePath}`)
    openBrowser(url)
    setTimeout(() => process.exit(0), 1500)
    return
  }
  const server = result.server
  const activeStore = state.store
  if (!activeStore) throw new Error('Локальная база не открыта.')

  let closing = false
  const shutdown = () => {
    if (closing) return
    closing = true
    server.close()
    server.closeAllConnections()
    try {
      activeStore.close()
    } finally {
      process.exit(0)
    }
  }
  // SIGHUP приходит при закрытии окна консоли Windows, SIGBREAK — по Ctrl+Break.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) {
    process.on(signal, shutdown)
  }

  server.once('error', (error: NodeJS.ErrnoException) => {
    try {
      activeStore.close()
    } catch {
      // база уже закрыта
    }
    fail(
      error.code === 'EADDRINUSE'
        ? `Порт ${port} занят другой программой. Закройте её или запустите редактор с другим портом, например: set TOD_PORT=4101 и затем editor-of-tod.exe`
        : `Не удалось запустить локальный сервер: ${error.message}`,
    )
  })

  if (port !== preferredPort)
    console.log(
      `Порт ${preferredPort} занят другим экземпляром или программой; используется ${port}.`,
    )
  console.log(`Адрес: ${url}`)
  console.log(`Данные: ${databasePath}`)
  if (portableNote) console.log(portableNote)
  console.log('Не закрывайте это окно во время работы. Чтобы остановить редактор, закройте его.')
  openBrowser(url)
}

main().catch((error: unknown) => {
  fail(`Редактор не запущен: ${error instanceof Error ? error.message : String(error)}`)
})
