import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { basename } from 'node:path'
import { parsePu66 } from './pu66.ts'
import { parseSignArchive } from './signs.ts'
import { RegistryStore } from './store.ts'

const databasePath = fileURLToPath(new URL('../private-data/registry.sqlite', import.meta.url))

export async function runImport(args: string[], store: RegistryStore): Promise<string> {
  const [kind, ...rest] = args
  const apply = rest.includes('--apply')
  const vectorize = rest.includes('--vector')
  const paths = rest.filter((arg) => !arg.startsWith('--'))
  if (
    (kind !== 'pu66' && kind !== 'signs') ||
    (kind === 'signs' ? paths.length !== 1 : paths.length < 1 || paths.length > 100) ||
    rest.some((arg) => arg.startsWith('--') && !['--apply', '--vector'].includes(arg)) ||
    (kind === 'pu66' && vectorize)
  ) {
    throw new Error(
      'Использование: npm run import:pu66 -- [--apply] файлы.xlsx... или npm run import:signs -- [--apply] [--vector] знаки.zip',
    )
  }
  const buffers = await Promise.all(
    paths.map(async (path) => {
      const info = await stat(path)
      if (!info.isFile() || info.size > (kind === 'pu66' ? 4 : 64) * 1024 * 1024) {
        throw new Error('Входной файл слишком велик или не является обычным файлом.')
      }
      return readFile(path)
    }),
  )
  if (kind === 'pu66') {
    const entries = await Promise.all(
      buffers.map((bytes, index) => parsePu66(bytes, basename(paths[index]!))),
    )
    const planned = store.planPu66(entries)
    if (!apply)
      return `Просмотр ПУ-66: новых ${planned.added}, обновлений ${planned.updated}, без изменений ${planned.unchanged}. Для записи добавьте --apply.`
    if (planned.added + planned.updated === 0) return 'ПУ-66: данные уже загружены, изменений нет.'
    const backup = await store.createBackup()
    const result = store.importPu66(entries)
    return `ПУ-66: добавлено ${result.added}, обновлено ${result.updated}, без изменений ${result.unchanged}. Резервная копия: private-data/backups/${backup}.`
  }
  const entries = parseSignArchive(buffers[0]!, vectorize)
  const planned = store.planSigns(entries)
  if (!apply)
    return `Просмотр знаков: новых ${planned.added}, обновлений ${planned.updated}, без изменений ${planned.unchanged}. Для записи добавьте --apply${vectorize ? ' --vector' : ''}.`
  if (planned.added + planned.updated === 0) return 'Знаки: данные уже загружены, изменений нет.'
  const backup = await store.createBackup()
  const result = store.importSigns(entries)
  return `Знаки: добавлено ${result.added}, обновлено ${result.updated}, без изменений ${result.unchanged}. Резервная копия: private-data/backups/${backup}.`
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077)
  const store = new RegistryStore(databasePath)
  try {
    console.log(await runImport(process.argv.slice(2), store))
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Ошибка импорта.')
    process.exitCode = 1
  } finally {
    store.close()
  }
}
