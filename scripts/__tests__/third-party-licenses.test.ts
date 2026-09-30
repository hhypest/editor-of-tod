import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  chooseLicense,
  licenseProblems,
  packageDirectory,
  packagesFromModules,
  renderNotices,
} from '../third-party-licenses.ts'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** Вымышленный пакет в node_modules временного каталога. */
function fakePackage(root: string, name: string, pkg: object, files: Record<string, string> = {}) {
  const directory = join(root, 'node_modules', ...name.split('/'))
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...pkg }))
  for (const [file, text] of Object.entries(files)) writeFileSync(join(directory, file), text)
  writeFileSync(join(directory, 'index.js'), '')
  return join(directory, 'index.js')
}

describe('third-party license notices', () => {
  it('accepts permissive licenses and picks MIT from a dual license', () => {
    expect(chooseLicense('MIT')).toBe('MIT')
    expect(chooseLicense('(MIT OR GPL-3.0-or-later)')).toBe('MIT')
    expect(chooseLicense('(MIT AND Zlib)')).toBe('MIT AND Zlib')
    expect(chooseLicense('GPL-3.0-only')).toBeNull()
    expect(chooseLicense('(MIT AND GPL-2.0)')).toBeNull()
    expect(chooseLicense(null)).toBeNull()
  })

  it('finds the package directory of a module, including scoped and nested packages', () => {
    expect(packageDirectory('/p/node_modules/vue/dist/vue.js')).toBe('/p/node_modules/vue')
    expect(packageDirectory('/p/node_modules/@vue/shared/dist/x.js')).toBe(
      '/p/node_modules/@vue/shared',
    )
    expect(packageDirectory('/p/node_modules/a/node_modules/b/lib/c.js?commonjs')).toBe(
      '/p/node_modules/a/node_modules/b',
    )
    expect(packageDirectory('/p/src/main.ts')).toBeNull()
  })

  it('collects license texts, templates missing files and stops on disallowed licenses', () => {
    const root = mkdtempSync(join(tmpdir(), 'tod-licenses-'))
    directories.push(root)
    const withFile = fakePackage(root, 'учебный-mit', { license: 'MIT' }, { LICENSE: 'MIT text' })
    const scoped = fakePackage(
      root,
      '@учебный/apache',
      { license: 'Apache-2.0' },
      { LICENSE: 'Apache text', NOTICE: 'Notice text' },
    )
    const noFile = fakePackage(root, 'учебный-isc', { license: 'ISC', author: 'Учебный автор' })
    const copyLeft = fakePackage(root, 'учебный-gpl', { license: 'GPL-3.0-only' }, { LICENSE: 'x' })

    const packages = packagesFromModules([withFile, scoped, noFile, withFile])
    expect(packages.map((item) => item.name)).toEqual([
      '@учебный/apache',
      'учебный-isc',
      'учебный-mit',
    ])
    expect(packages[0]!.texts.map((text) => text.file)).toEqual(['LICENSE', 'NOTICE'])
    expect(packages[1]!.texts[0]!.text).toContain('Copyright (c) Учебный автор')
    expect(licenseProblems(packages)).toEqual([])
    expect(licenseProblems(packagesFromModules([copyLeft]))).toEqual([
      'учебный-gpl@1.0.0: лицензия «GPL-3.0-only» не входит в разрешённые',
    ])

    const text = renderNotices({
      groups: [{ title: 'Учебная группа', packages }],
      node: { version: '24.0.0', text: 'Node.js is licensed for use as follows: …' },
    })
    expect(text).toContain('учебный-mit 1.0.0 — MIT')
    expect(text).toContain('--- NOTICE ---\nNotice text')
    expect(text).toContain('Среда выполнения Node.js 24.0.0')
  })
})
