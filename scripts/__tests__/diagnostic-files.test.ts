import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  diagnosticProgramFiles,
  renderDiagnosticFiles,
  writeDiagnosticFiles,
} from '../diagnostic-files'
import { diagnosticFrames } from '../../src/shared/diagnostic-data'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tod-diagnostic-files-'))
  directories.push(root)
  const write = (path: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), '')
  }
  return { root, write }
}

describe('build-time diagnostic allowlist', () => {
  it('collects new nested production modules deterministically and excludes private/test/non-code files', () => {
    const { root, write } = fixture()
    for (const path of [
      'src/stores/new-session.ts',
      'server/repositories/new.ts',
      'src/components/New.vue',
      'scripts/new-build.mjs',
      'private-data/src/secret.ts',
      'src/private.sqlite',
      'src/__tests__/secret.ts',
      'server/new.test.ts',
      'server/new.spec.ts',
      'src/env.d.ts',
      'src/.private/secret.ts',
      'node_modules/pkg/index.ts',
      'src/shared/diagnostic-files.generated.ts',
    ])
      write(path)
    expect(diagnosticProgramFiles(root)).toEqual([
      'scripts/new-build.mjs',
      'server.cjs',
      'server/repositories/new.ts',
      'server/store.ts',
      'src/components/New.vue',
      'src/stores/new-session.ts',
    ])
    const rendered = renderDiagnosticFiles(root)
    expect(rendered).not.toContain(root)
    expect(rendered).not.toContain('secret')
  })

  it('rejects symlink files and directories instead of walking outside the source tree', () => {
    const { root, write } = fixture()
    write('src/real.ts')
    write('private-data/secret.ts')
    symlinkSync(join(root, 'private-data'), join(root, 'server'), 'junction')
    // Windows file symlinks require extra OS privileges; junction directories do not.
    if (process.platform !== 'win32')
      symlinkSync(join(root, 'private-data/secret.ts'), join(root, 'src/linked.ts'))
    expect(diagnosticProgramFiles(root)).toEqual(['server.cjs', 'server/store.ts', 'src/real.ts'])
  })

  it('regenerates after additions/deletions and reports stale source execution manifests', () => {
    const { root, write } = fixture()
    write('src/shared/placeholder.ts')
    writeDiagnosticFiles(root)
    expect(() => writeDiagnosticFiles(root, true)).not.toThrow()
    write('server/new.ts')
    expect(() => writeDiagnosticFiles(root, true)).toThrow('Список диагностики устарел')
    writeDiagnosticFiles(root)
    expect(readFileSync(join(root, 'src/shared/diagnostic-files.generated.ts'), 'utf8')).toContain(
      'server/new.ts',
    )
    rmSync(join(root, 'server/new.ts'))
    writeDiagnosticFiles(root)
    expect(
      readFileSync(join(root, 'src/shared/diagnostic-files.generated.ts'), 'utf8'),
    ).not.toContain('server/new.ts')
  })

  it('keeps the repository manifest current and strips unknown paths/function names from actual frames', () => {
    const root = fileURLToPath(new URL('../..', import.meta.url))
    expect(() => writeDiagnosticFiles(root, true)).not.toThrow()
    expect(
      diagnosticFrames(
        [
          ' at PrivateName (C:\\private\\server\\http\\server.ts:12:3)',
          ' at PrivateName (/private/src/stores/project-document.ts:11:4)',
          ' at PrivateName (/private/src/unknown.ts:10:2)',
          ' at PrivateName (/private/private-data/secret.ts:1:1)',
        ].join('\n'),
      ),
    ).toEqual(['server/http/server.ts:12:3', 'src/stores/project-document.ts:11:4'])
  })
})
