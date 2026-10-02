import type { Server } from 'node:http'
import { createRegistryServer } from '../index'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { PNG } from 'pngjs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DocumentMeta } from '../../src/domain/normative-documents'
import { applyDocumentUpload, previewDocumentUpload } from '../document-web-import'
import { applySignUpload, previewSignUpload } from '../sign-web-import'
import { DocumentInUse, RegistryStore, RevisionConflict } from '../store'

const directories: string[] = []
function store() {
  const directory = mkdtempSync(join(tmpdir(), 'tod-documents-'))
  directories.push(directory)
  return { directory, store: new RegistryStore(join(directory, 'registry.sqlite')) }
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function pdf(text: string) {
  return Buffer.from(`%PDF-1.4\n${text}`)
}
function meta(partial: Partial<DocumentMeta> = {}): DocumentMeta {
  return {
    code: 'ГОСТ Р 90000',
    edition: '2024',
    title: 'Учебный стандарт знаков',
    kind: 'signs',
    effectiveFrom: '2026-01-01',
    amendsId: null,
    note: '',
    actualCheckedAt: '',
    ...partial,
  }
}
function upload(text: string, partial: Partial<DocumentMeta> = {}) {
  return { file: { name: 'uchebny.pdf', data: pdf(text).toString('base64') }, meta: meta(partial) }
}
function signs(color: number, documentId: number | null) {
  const image = new PNG({ width: 12, height: 12 })
  image.data.fill(color)
  const png = PNG.sync.write(image)
  return {
    archive: {
      name: 'synthetic.zip',
      data: Buffer.from(
        zipSync({ 'PNG с номером/1.25.png': png, 'PNG без номера/1.25.png': png }),
      ).toString('base64'),
    },
    pdf: null,
    documentCode: 'не используется',
    edition: 'не используется',
    documentId,
  }
}
const today = new Date('2026-09-29T12:00:00')

describe('normative document library', () => {
  it.each([
    { code: 'ГОСТ Р 90001' },
    { edition: '2025' },
    { title: 'Изменённое название' },
    { kind: 'rules' as const },
    { effectiveFrom: '2027-01-01' },
    { amendsId: 1 },
    { note: 'Новое примечание' },
    { actualCheckedAt: '2026-09-29' },
  ])('rejects stale PDF previews after library metadata changes: %j', async (change) => {
    const { store: registry } = store()
    try {
      registry.addDocument(meta({ edition: '2020' }), 'parent.pdf', pdf('parent'), '1'.repeat(64))
      const existing = registry.addDocument(
        meta({ edition: '2022' }),
        'existing.pdf',
        pdf('existing'),
        '2'.repeat(64),
      )
      const body = upload('candidate')
      const preview = previewDocumentUpload(registry, body, today)
      registry.updateDocument(existing.id, meta({ edition: '2022', ...change }))
      await expect(
        applyDocumentUpload(registry, { ...body, expectedFingerprint: preview.fingerprint }, today),
      ).rejects.toBeInstanceOf(RevisionConflict)
      expect(registry.listDocuments()).toHaveLength(2)
      expect(registry.findDocumentBySha(preview.sha256)).toBeNull()
    } finally {
      registry.close()
    }
  })

  it('rechecks PDF metadata during backup and rejects a preview from another date', async () => {
    const { store: registry } = store()
    try {
      const existing = registry.addDocument(
        meta({ edition: '2022' }),
        'existing.pdf',
        pdf('existing'),
        '2'.repeat(64),
      )
      const body = upload('candidate')
      const preview = previewDocumentUpload(registry, body, today)
      await expect(
        applyDocumentUpload(
          registry,
          { ...body, expectedFingerprint: preview.fingerprint },
          new Date('2026-09-30T12:00:00'),
        ),
      ).rejects.toBeInstanceOf(RevisionConflict)
      const backup = vi.spyOn(registry, 'createBackup').mockImplementation(async () => {
        registry.updateDocument(existing.id, meta({ edition: '2022', effectiveFrom: '2027-01-01' }))
        return 'synthetic-backup.sqlite'
      })
      await expect(
        applyDocumentUpload(registry, { ...body, expectedFingerprint: preview.fingerprint }, today),
      ).rejects.toBeInstanceOf(RevisionConflict)
      expect(backup).toHaveBeenCalledOnce()
      expect(registry.listDocuments()).toHaveLength(1)
      expect(registry.findDocumentBySha(preview.sha256)).toBeNull()
    } finally {
      registry.close()
    }
  })

  it('returns HTTP 409 without storing the PDF after metadata changes, and HTTP 400 for a ZIP linked to rules', async () => {
    const { store: registry } = store()
    let server: Server | undefined
    try {
      const existing = registry.addDocument(
        meta({ edition: '2022' }),
        'existing.pdf',
        pdf('existing'),
        '2'.repeat(64),
      )
      server = createRegistryServer(registry, 0)
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Missing server address')
      const base = `http://127.0.0.1:${address.port}`
      const post = (path: string, body: unknown) =>
        fetch(base + path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173' },
          body: JSON.stringify(body),
        })
      const body = upload('http-candidate')
      const response = await post('/api/documents/preview', body)
      expect(response.status).toBe(200)
      const preview = (await response.json()) as { fingerprint: string; sha256: string }
      registry.updateDocument(
        existing.id,
        meta({ edition: '2022', kind: 'rules', effectiveFrom: '2027-01-01' }),
      )
      expect(
        (
          await post('/api/documents/apply', {
            ...body,
            expectedFingerprint: preview.fingerprint,
          })
        ).status,
      ).toBe(409)
      expect(registry.findDocumentBySha(preview.sha256)).toBeNull()
      expect(registry.listDocuments()).toHaveLength(1)
      expect((await post('/api/signs/import/preview', signs(255, existing.id))).status).toBe(400)
      expect(registry.latestSignCatalog()).toBeNull()
    } finally {
      if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()))
      registry.close()
    }
  })

  it('stores attached PDFs privately and reports which edition becomes current', async () => {
    const { directory, store: registry } = store()
    try {
      const first = previewDocumentUpload(
        registry,
        upload('old', { edition: '2004', effectiveFrom: '2006-01-01' }),
        today,
      )
      expect(first).toMatchObject({
        duplicate: null,
        effect: { status: { kind: 'current' }, replaces: [] },
      })
      const old = await applyDocumentUpload(
        registry,
        {
          ...upload('old', { edition: '2004', effectiveFrom: '2006-01-01' }),
          expectedFingerprint: first.fingerprint,
        },
        today,
      )
      expect(old.backup).toMatch(/\.sqlite$/)
      expect(readdirSync(join(directory, 'backups'))).toHaveLength(1)
      const next = previewDocumentUpload(registry, upload('new'), today)
      expect(next.effect).toEqual({
        status: { kind: 'current' },
        replaces: [{ id: old.document.id, code: 'ГОСТ Р 90000', edition: '2004' }],
      })
      const added = await applyDocumentUpload(
        registry,
        { ...upload('new'), expectedFingerprint: next.fingerprint },
        today,
      )
      expect(registry.listDocuments().map((document) => document.edition)).toEqual(['2004', '2024'])
      expect(Buffer.from(registry.getDocumentPdf(added.document.id)!.pdf).toString()).toContain(
        'new',
      )
      // Повторный PDF не добавляется.
      expect(previewDocumentUpload(registry, upload('new'), today).duplicate?.id).toBe(
        added.document.id,
      )
      await expect(
        applyDocumentUpload(
          registry,
          { ...upload('new'), expectedFingerprint: next.fingerprint },
          today,
        ),
      ).rejects.toThrow()
    } finally {
      registry.close()
    }
  })

  it('attaches amendments only to a base document and protects referenced documents', async () => {
    const { store: registry } = store()
    try {
      const base = registry.addDocument(
        meta({ kind: 'rules' }),
        'base.pdf',
        pdf('base'),
        'b'.repeat(64),
      )
      const change = registry.addDocument(
        meta({ kind: 'rules', edition: 'Изменение № 1', amendsId: base.id }),
        'change.pdf',
        pdf('change'),
        'c'.repeat(64),
      )
      expect(() =>
        registry.addDocument(meta({ amendsId: change.id }), 'x.pdf', pdf('x'), 'd'.repeat(64)),
      ).toThrow(DocumentInUse)
      expect(() => registry.deleteDocument(base.id)).toThrow('изменения')
      expect(
        registry.updateDocument(base.id, meta({ kind: 'rules', actualCheckedAt: '2026-09-29' })),
      ).toMatchObject({ actualCheckedAt: '2026-09-29' })
      expect(registry.deleteDocument(change.id)).toBe(true)
      expect(registry.deleteDocument(base.id)).toBe(true)
      expect(registry.listDocuments()).toEqual([])
    } finally {
      registry.close()
    }
  })

  it('takes the sign catalog source from the chosen document and lists changed signs', async () => {
    const { store: registry } = store()
    try {
      const old = registry.addDocument(
        meta({ edition: '2004' }),
        'old.pdf',
        pdf('old'),
        'e'.repeat(64),
      )
      const current = registry.addDocument(meta(), 'new.pdf', pdf('new'), 'f'.repeat(64))
      const first = signs(200, old.id)
      const preview = previewSignUpload(registry, first)
      expect(preview.source).toEqual({
        documentCode: 'ГОСТ Р 90000',
        edition: '2004',
        pdfSha256: 'e'.repeat(64),
        documentId: old.id,
      })
      await applySignUpload(registry, { ...first, expectedFingerprint: preview.fingerprint })
      expect(registry.latestSignCatalog()).toMatchObject({ edition: '2004', documentId: old.id })
      expect(() => registry.deleteDocument(old.id)).toThrow('каталога знаков')

      // Та же картинка по новой редакции: сменился только источник.
      expect(previewSignUpload(registry, signs(200, current.id))).toMatchObject({
        updated: 1,
        relabelled: 1,
        changedCodes: [],
        changedPreviews: [],
      })
      // Новое изображение: знак в списке изменённых с превью для сравнения.
      const redrawn = previewSignUpload(registry, signs(90, current.id))
      expect(redrawn).toMatchObject({ updated: 1, relabelled: 0, changedCodes: ['1.25'] })
      expect(redrawn.changedPreviews[0]?.image).toMatch(/^data:image\/png;base64,/)
    } finally {
      registry.close()
    }
  })
})
