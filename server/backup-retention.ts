import { lstat, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

// Only files created by RegistryStore.createBackup are eligible. Other files are left alone.
const backupName =
  /^registry-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-[a-f0-9]{8}\.sqlite$/

export type BackupItem = {
  filename: string
  size: number
  createdAtMs: number
  mtimeMs: number
  dev: number
  ino: number
}

export type BackupPlan = { keep: BackupItem[]; remove: BackupItem[] }

export async function planBackupPrune(
  directory: string,
  options: { keep: number; maxAgeDays: number; now?: number },
): Promise<BackupPlan> {
  if (!Number.isSafeInteger(options.keep) || options.keep < 1)
    throw new Error('--keep должен быть положительным целым числом.')
  if (!Number.isSafeInteger(options.maxAgeDays) || options.maxAgeDays < 1)
    throw new Error('--max-age-days должен быть положительным целым числом.')
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { keep: [], remove: [] }
    throw error
  }
  const backups: BackupItem[] = []
  for (const entry of entries) {
    const match = backupName.exec(entry.name)
    if (!entry.isFile() || !match) continue
    const createdAtMs = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`)
    if (!Number.isFinite(createdAtMs)) continue
    const info = await lstat(join(directory, entry.name))
    if (info.isFile()) {
      backups.push({
        filename: entry.name,
        size: info.size,
        createdAtMs,
        mtimeMs: info.mtimeMs,
        dev: info.dev,
        ino: info.ino,
      })
    }
  }
  backups.sort((a, b) => b.createdAtMs - a.createdAtMs || b.filename.localeCompare(a.filename))
  const cutoff = (options.now ?? Date.now()) - options.maxAgeDays * 24 * 60 * 60 * 1_000
  const plan: BackupPlan = { keep: [], remove: [] }
  backups.forEach((item, index) => {
    // Always retain the newest usable backup, even when it is older than the age limit.
    const destination =
      index === 0 || (index < options.keep && item.createdAtMs >= cutoff) ? plan.keep : plan.remove
    destination.push(item)
  })
  return plan
}

export async function applyBackupPrune(directory: string, plan: BackupPlan): Promise<void> {
  for (const item of plan.remove) {
    const path = join(directory, item.filename)
    const current = await lstat(path)
    if (
      !backupName.test(item.filename) ||
      !current.isFile() ||
      current.dev !== item.dev ||
      current.ino !== item.ino ||
      current.size !== item.size ||
      current.mtimeMs !== item.mtimeMs
    ) {
      throw new Error(`Резервная копия изменилась: ${item.filename}. Повторите просмотр.`)
    }
  }
  for (const item of plan.remove) await unlink(join(directory, item.filename))
}
