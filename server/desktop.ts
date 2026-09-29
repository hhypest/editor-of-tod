// Точка входа исполняемого файла (Node.js single executable application).
// Запускает локальный API и интерфейс на 127.0.0.1 и открывает браузер.
// Без упаковки запускается командой `npm run desktop` и берёт интерфейс из `dist/`.
import { exec } from 'node:child_process'
import { get } from 'node:http'
import { dirname, join } from 'node:path'
import { getAsset, isSea } from 'node:sea'
import { resolveDataDirectory, resolvePort } from './app-paths.ts'
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

function alreadyRunning(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const request = get(new URL('api/status', url), { timeout: 1500 }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => (body += chunk))
      response.on('end', () =>
        resolve(response.statusCode === 200 && body.includes('"ready":true')),
      )
    })
    request.on('timeout', () => request.destroy())
    request.on('error', () => resolve(false))
  })
}

async function main(): Promise<void> {
  const port = resolvePort(process.env.TOD_PORT, DEFAULT_PORT)
  const url = `http://127.0.0.1:${port}/`
  console.log(`Редактор схем ОДД ${version}`)

  if (await alreadyRunning(url)) {
    console.log(`Редактор уже запущен: ${url}\nОткрываю его в браузере.`)
    openBrowser(url)
    setTimeout(() => process.exit(0), 1500)
    return
  }

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

  const store = new RegistryStore(databasePath)
  const server = createRegistryServer(store, port, isSea() ? seaFiles() : undefined)

  let closing = false
  const shutdown = () => {
    if (closing) return
    closing = true
    server.close()
    server.closeAllConnections()
    try {
      store.close()
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
      store.close()
    } catch {
      // база уже закрыта
    }
    fail(
      error.code === 'EADDRINUSE'
        ? `Порт ${port} занят другой программой. Закройте её или запустите редактор с другим портом, например: set TOD_PORT=4101 и затем editor-of-tod.exe`
        : `Не удалось запустить локальный сервер: ${error.message}`,
    )
  })

  server.listen(port, '127.0.0.1', () => {
    console.log(`Адрес: ${url}`)
    console.log(`Данные: ${databasePath}`)
    if (portableNote) console.log(portableNote)
    console.log('Не закрывайте это окно во время работы. Чтобы остановить редактор, закройте его.')
    openBrowser(url)
  })
}

main().catch((error: unknown) => {
  fail(`Редактор не запущен: ${error instanceof Error ? error.message : String(error)}`)
})
