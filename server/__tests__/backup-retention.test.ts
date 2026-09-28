import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  utimesSync,
  symlinkSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyBackupPrune, planBackupPrune } from '../backup-retention'
import { runBackupPrune } from '../backup-cli'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function backup(directory: string, day: number): string {
  const filename = `registry-2026-01-${String(day).padStart(2, '0')}T00-00-00-000Z-12345678.sqlite`
  const path = join(directory, filename)
  writeFileSync(path, 'synthetic backup')
  const time = new Date(`2026-01-${String(day).padStart(2, '0')}T00:00:00Z`)
  utimesSync(path, time, time)
  return filename
}

describe('opt-in backup retention', () => {
  it('previews an age/count policy, keeps at least one, and ignores unrelated files', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-backups-'))
    directories.push(directory)
    const backups = join(directory, 'backups')
    mkdirSync(backups)
    const names = [backup(backups, 1), backup(backups, 2), backup(backups, 3), backup(backups, 4)]
    const laterMtime = new Date('2026-07-01T00:00:00Z')
    utimesSync(join(backups, names[0]!), laterMtime, laterMtime)
    writeFileSync(join(backups, 'my-own-copy.sqlite'), 'keep this')
    symlinkSync(
      join(backups, names[0]!),
      join(backups, 'registry-2026-01-05T00-00-00-000Z-12345678.sqlite'),
    )
    const now = new Date('2026-01-06T00:00:00Z').getTime()
    const plan = await planBackupPrune(backups, { keep: 2, maxAgeDays: 3, now })
    expect(plan.keep.map((item) => item.filename)).toEqual([names[3], names[2]])
    expect(plan.remove.map((item) => item.filename)).toEqual([names[1], names[0]])
    expect(
      await runBackupPrune(
        ['--keep', '2', '--max-age-days', '3'],
        join(directory, 'registry.sqlite'),
      ),
    ).toContain('Это только просмотр')
    expect(existsSync(join(backups, names[0]!))).toBe(true)
    await applyBackupPrune(backups, plan)
    expect(existsSync(join(backups, names[0]!))).toBe(false)
    expect(existsSync(join(backups, 'my-own-copy.sqlite'))).toBe(true)
    expect(existsSync(join(backups, names[3]!))).toBe(true)

    const last = await planBackupPrune(backups, {
      keep: 1,
      maxAgeDays: 1,
      now: now + 100 * 86_400_000,
    })
    expect(last.keep.map((item) => item.filename)).toEqual([names[3]])
  })

  it('stops when a selected file changed between preview and deletion', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-backups-'))
    directories.push(directory)
    const old = backup(directory, 1)
    backup(directory, 2)
    const plan = await planBackupPrune(directory, { keep: 1, maxAgeDays: 90, now: Date.now() })
    writeFileSync(join(directory, old), 'changed after preview')
    await expect(applyBackupPrune(directory, plan)).rejects.toThrow('изменилась')
    expect(existsSync(join(directory, old))).toBe(true)
    await expect(
      runBackupPrune(['--keep', '0'], join(directory, 'registry.sqlite')),
    ).rejects.toThrow()
  })
})
