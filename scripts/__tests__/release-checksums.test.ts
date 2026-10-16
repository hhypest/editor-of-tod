import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CHECKSUMS_FILE, checksumLines, writeChecksums } from '../release-checksums.mjs'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('release checksums', () => {
  it('lists SHA-256 of every file in sha256sum format, sorted by name', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-release-'))
    directories.push(directory)
    writeFileSync(join(directory, 'editor-of-tod.exe'), 'учебная программа')
    writeFileSync(join(directory, 'LICENSE.txt'), 'MIT')
    const hash = (text: string) => createHash('sha256').update(text).digest('hex')
    const expected = `${hash('MIT')}  LICENSE.txt\n${hash('учебная программа')}  editor-of-tod.exe\n`
    expect(checksumLines(directory, ['editor-of-tod.exe', 'LICENSE.txt'])).toBe(expected)
    expect(writeChecksums(directory, ['editor-of-tod.exe', 'LICENSE.txt'])).toBe(expected)
    expect(readFileSync(join(directory, CHECKSUMS_FILE), 'utf8')).toBe(expected)
  })

  it('refuses a missing file instead of writing an incomplete list', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-release-'))
    directories.push(directory)
    expect(() => checksumLines(directory, ['editor-of-tod.exe'])).toThrow()
  })
})

describe('release version', () => {
  const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
  const version = (JSON.parse(read('package.json')) as { version: string }).version

  it('is the same in package.json, the lockfile and a changelog section', () => {
    const lock = JSON.parse(read('package-lock.json')) as {
      version: string
      packages: Record<string, { version?: string }>
    }
    expect(lock.version).toBe(version)
    expect(lock.packages['']?.version).toBe(version)
    expect(read('CHANGELOG.md')).toContain(`## [${version}]`)
  })
})
