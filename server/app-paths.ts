import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface DataLocation {
  /** Папка с `registry.sqlite` и `backups/`. */
  readonly directory: string
  /** `true`, если данные лежат рядом с исполняемым файлом (переносная установка). */
  readonly portable: boolean
}

function writable(directory: string): boolean {
  try {
    mkdirSync(directory, { recursive: true })
    const probe = join(directory, `.write-test-${process.pid}`)
    writeFileSync(probe, '')
    unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

/**
 * Выбирает папку данных для исполняемого файла без прав администратора.
 * Сначала `private-data` рядом с программой, чтобы папку можно было перенести целиком;
 * если туда нельзя писать (например, программа лежит в защищённом каталоге),
 * используется профиль пользователя: `%LOCALAPPDATA%\editor-of-tod\private-data`.
 */
export function resolveDataDirectory(
  executableDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): DataLocation {
  const portable = join(executableDirectory, 'private-data')
  if (writable(portable)) return { directory: portable, portable: true }
  const base =
    platform === 'win32'
      ? (env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'))
      : (env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'))
  const fallback = join(base, 'editor-of-tod', 'private-data')
  if (writable(fallback)) return { directory: fallback, portable: false }
  throw new Error(`Нет доступа на запись ни к «${portable}», ни к «${fallback}».`)
}

/** Порт из `TOD_PORT` или стандартный; неверное значение отклоняется явно. */
export function resolvePort(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Неверный порт TOD_PORT=${value}: укажите число от 1 до 65535.`)
  }
  return port
}
