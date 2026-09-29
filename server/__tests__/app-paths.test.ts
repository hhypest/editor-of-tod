import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveDataDirectory, resolvePort } from '../app-paths'

const directories: string[] = []
function temporary() {
  const directory = mkdtempSync(join(tmpdir(), 'tod-paths-'))
  directories.push(directory)
  return directory
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('data directory for the executable', () => {
  it('keeps data next to the program when the folder is writable', () => {
    const program = temporary()
    const location = resolveDataDirectory(program, {}, 'win32')
    expect(location).toEqual({ directory: join(program, 'private-data'), portable: true })
    expect(existsSync(location.directory)).toBe(true)
  })

  it('falls back to the user profile when the program folder cannot be written', () => {
    const blocked = temporary()
    // Файл на месте каталога программы: создать private-data внутри невозможно.
    const program = join(blocked, 'editor-of-tod.exe')
    writeFileSync(program, '')
    const profile = temporary()
    const location = resolveDataDirectory(program, { LOCALAPPDATA: profile }, 'win32')
    expect(location).toEqual({
      directory: join(profile, 'editor-of-tod', 'private-data'),
      portable: false,
    })
  })
})

describe('port override', () => {
  it('uses the default and accepts a valid TOD_PORT', () => {
    expect(resolvePort(undefined, 4100)).toBe(4100)
    expect(resolvePort(' ', 4100)).toBe(4100)
    expect(resolvePort('4101', 4100)).toBe(4101)
  })

  it('rejects an invalid TOD_PORT', () => {
    for (const value of ['0', '70000', '41.5', 'порт']) {
      expect(() => resolvePort(value, 4100)).toThrow(/TOD_PORT/)
    }
  })
})
