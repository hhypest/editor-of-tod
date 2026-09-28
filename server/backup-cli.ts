import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { applyBackupPrune, planBackupPrune } from './backup-retention.ts'

const defaultDatabasePath = fileURLToPath(
  new URL('../private-data/registry.sqlite', import.meta.url),
)

function parseArgs(args: string[]): { apply: boolean; keep: number; maxAgeDays: number } {
  let apply = false
  let keep = 20
  let maxAgeDays = 90
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--apply') apply = true
    else if (arg === '--keep' || arg === '--max-age-days') {
      const value = args[++index]
      if (!value || !/^\d+$/.test(value)) throw new Error(`Укажите целое число после ${arg}.`)
      if (arg === '--keep') keep = Number(value)
      else maxAgeDays = Number(value)
    } else throw new Error(`Неизвестный аргумент: ${arg}.`)
  }
  return { apply, keep, maxAgeDays }
}

export async function runBackupPrune(
  args: string[],
  databasePath = defaultDatabasePath,
): Promise<string> {
  const options = parseArgs(args)
  const directory = join(dirname(databasePath), 'backups')
  const plan = await planBackupPrune(directory, options)
  if (options.apply) await applyBackupPrune(directory, plan)
  const names = plan.remove.map((item) => `  ${item.filename}`).join('\n')
  return [
    `${options.apply ? 'Удалено' : 'К удалению'}: ${plan.remove.length}; останется: ${plan.keep.length}.`,
    ...(names ? [names] : []),
    ...(options.apply ? [] : ['Это только просмотр. Для удаления добавьте --apply.']),
  ].join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077)
  try {
    console.log(await runBackupPrune(process.argv.slice(2), process.env.TOD_DATABASE_PATH))
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Ошибка при проверке резервных копий.')
    process.exitCode = 1
  }
}
