import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { PNG } from 'pngjs'
import { describe, expect, it, vi } from 'vitest'
import { applySignUpload, previewSignUpload } from '../sign-web-import'
import { RegistryStore, RevisionConflict } from '../store'

function request(code: string) {
  const image = new PNG({ width: 12, height: 12 })
  image.data.fill(255)
  const png = PNG.sync.write(image)
  const archive = Buffer.from(
    zipSync({
      [`PNG с номером/${code}.png`]: png,
      [`PNG без номера/${code}.png`]: png,
    }),
  )
  return {
    archive: { name: 'synthetic.zip', data: archive.toString('base64') },
    pdf: { name: 'source.pdf', data: Buffer.from('%PDF-1.4\nsynthetic').toString('base64') },
    documentCode: 'ГОСТ Р TEST',
    edition: '2024',
  }
}

describe('local sign archive preview and apply', () => {
  it.each(['rules', 'methodology', 'other'] as const)(
    'rejects ZIP attachment to %s documents before writing',
    async (kind) => {
      const store = new RegistryStore(':memory:')
      try {
        const document = store.addDocument(
          {
            code: 'УЧЕБНЫЙ',
            edition: '2024',
            title: '',
            kind,
            effectiveFrom: '',
            amendsId: null,
            note: '',
            actualCheckedAt: '',
          },
          'fake.pdf',
          Buffer.from('%PDF-1.4'),
          '1'.repeat(64),
        )
        const body = { ...request('1.25'), documentId: document.id }
        expect(() => previewSignUpload(store, body)).toThrow('вида «Изображения знаков»')
        await expect(
          applySignUpload(store, { ...body, expectedFingerprint: '0'.repeat(64) }),
        ).rejects.toThrow('вида «Изображения знаков»')
        expect(store.latestSignCatalog()).toBeNull()
        expect(store.listSigns()).toEqual([])
      } finally {
        store.close()
      }
    },
  )

  it.each(['kind', 'edition', 'deleted'] as const)(
    'revalidates the selected ZIP document during backup: %s',
    async (change) => {
      const store = new RegistryStore(':memory:')
      try {
        const meta = {
          code: 'УЧЕБНЫЙ',
          edition: '2024',
          title: '',
          kind: 'signs' as const,
          effectiveFrom: '',
          amendsId: null,
          note: '',
          actualCheckedAt: '',
        }
        const document = store.addDocument(
          meta,
          'fake.pdf',
          Buffer.from('%PDF-1.4'),
          '1'.repeat(64),
        )
        const body = { ...request('1.25'), documentId: document.id }
        const preview = previewSignUpload(store, body)
        vi.spyOn(store, 'createBackup').mockImplementation(async () => {
          if (change === 'deleted') store.deleteDocument(document.id)
          else
            store.updateDocument(document.id, {
              ...meta,
              ...(change === 'kind' ? { kind: 'rules' as const } : { edition: '2026' }),
            })
          return 'synthetic-backup.sqlite'
        })
        await expect(
          applySignUpload(store, { ...body, expectedFingerprint: preview.fingerprint }),
        ).rejects.toBeInstanceOf(RevisionConflict)
        expect(store.latestSignCatalog()).toBeNull()
        expect(store.listSigns()).toEqual([])
      } finally {
        store.close()
      }
    },
  )

  it('requires the reviewed fingerprint and keeps the source and PNG in private SQLite', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-sign-web-'))
    const store = new RegistryStore(join(directory, 'registry.sqlite'))
    try {
      const body = request('1.25')
      const preview = previewSignUpload(store, body)
      expect(preview).toMatchObject({ added: 1, signCount: 1 })
      expect(preview.source.pdfSha256).toMatch(/^[0-9a-f]{64}$/)
      await expect(
        applySignUpload(store, { ...body, expectedFingerprint: '0'.repeat(64) }),
      ).rejects.toThrow()
      const result = await applySignUpload(store, {
        ...body,
        expectedFingerprint: preview.fingerprint,
      })
      expect(result).toMatchObject({ added: 1, backup: expect.any(String) })
      expect(store.latestSignCatalog()).toMatchObject({ edition: '2024', signCount: 1 })
      await expect(
        applySignUpload(store, { ...body, expectedFingerprint: preview.fingerprint }),
      ).rejects.toThrow()
      const unchanged = previewSignUpload(store, body)
      expect(unchanged).toMatchObject({ unchanged: 1, added: 0, updated: 0, retired: 0 })
      const altered = request('1.20.2')
      expect(previewSignUpload(store, altered)).toMatchObject({ added: 1, retired: 1 })
      expect(() =>
        previewSignUpload(store, {
          ...altered,
          pdf: { name: 'bad.pdf', data: Buffer.from('wrong').toString('base64') },
        }),
      ).toThrow('не является PDF')
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
