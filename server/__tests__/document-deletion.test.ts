import { openTestApplication } from './test-application'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHttpServer } from '../http/server'
import { NormativeDocumentRepository } from '../documents/normative-document-repository'
import { evidenceConfirmation } from './document-evidence-fixture'

import { documentMeta, documentFile, seedDocumentBatch } from './normative-document-fixture'

const cleanups: Array<() => void> = [],
  servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()))
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'tod-delete-document-')),
    path = join(directory, 'registry.sqlite'),
    store = openTestApplication(path),
    raw = new DatabaseSync(path),
    file = documentFile(),
    document = store.documentService.add(documentMeta(), file.filename, file.pdf, file.sha256),
    pages = ['Fictional first page', '', 'Fictional third page']
  store.documentText.save(document.id, pages)
  cleanups.push(() => {
    raw.close()
    store.runtime.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return { directory, path, store, raw, document, file, pages }
}

describe('atomic normative document deletion', () => {
  it('restores cached text and leaves the full document untouched when the final DELETE fails', () => {
    const { store, raw, document, pages, file } = setup(),
      before = raw.prepare('SELECT * FROM normative_documents').all()
    raw.exec(
      "CREATE TRIGGER reject_document_delete BEFORE DELETE ON normative_documents BEGIN SELECT RAISE(ABORT, 'document delete failed'); END",
    )
    expect(() => store.deleteDocumentCommand.execute(document.id)).toThrow('document delete failed')
    expect(store.documentText.get(document.id)).toEqual(pages)
    expect(raw.prepare('SELECT * FROM normative_documents').all()).toEqual(before)
    expect(Buffer.from(store.documents.getPdf(document.id)!.pdf)).toEqual(file.pdf)
    raw.exec('DROP TRIGGER reject_document_delete')
    expect(store.deleteDocumentCommand.execute(document.id)).toBe(true)
    expect(store.documents.get(document.id)).toBeNull()
    expect(store.documentText.get(document.id)).toBeNull()
  })

  it('rolls back an aborted page DELETE without touching the document or leaving an open transaction', () => {
    const { store, raw, document, pages } = setup()
    raw.exec(
      "CREATE TRIGGER reject_page_delete BEFORE DELETE ON document_pages WHEN OLD.page = 2 BEGIN SELECT RAISE(ABORT, 'page delete failed'); END",
    )
    expect(() => store.deleteDocumentCommand.execute(document.id)).toThrow('page delete failed')
    expect(store.documents.get(document.id)).toEqual(document)
    expect(store.documentText.get(document.id)).toEqual(pages)
    raw.exec('DROP TRIGGER reject_page_delete')
    expect(store.deleteDocumentCommand.execute(document.id)).toBe(true)
  })

  it('preserves historical sign/amendment/confirmation guard order and all content on each refusal', () => {
    const { store, raw, document, pages } = setup(),
      changeFile = documentFile('Fictional amendment'),
      amendment = store.documentService.add(
        documentMeta({ amendsId: document.id }),
        changeFile.filename,
        changeFile.pdf,
        changeFile.sha256,
      )
    seedDocumentBatch(raw, document.id)
    const confirmation = store.parameterConfirmations.add(
      evidenceConfirmation({ documentId: document.id }),
    )
    expect(() => store.deleteDocumentCommand.execute(document.id)).toThrow(
      'С этим документом сверен импорт каталога знаков',
    )
    expect(store.documentText.get(document.id)).toEqual(pages)
    raw.prepare('DELETE FROM sign_catalog_batches WHERE document_id = ?').run(document.id)
    expect(() => store.deleteDocumentCommand.execute(document.id)).toThrow(
      'Сначала удалите изменения',
    )
    expect(store.documentText.get(document.id)).toEqual(pages)
    expect(store.deleteDocumentCommand.execute(amendment.id)).toBe(true)
    expect(() => store.deleteDocumentCommand.execute(document.id)).toThrow(
      'По этому документу подтверждены нормативные параметры',
    )
    expect(store.documentText.get(document.id)).toEqual(pages)
    expect(store.parameterConfirmations.list()).toEqual([confirmation])
    expect(store.documents.get(document.id)).toEqual(document)
    expect(raw.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('acquires the write lock before the initial existence/reference checks', () => {
    const { store, raw, document } = setup(),
      get = NormativeDocumentRepository.prototype.get
    raw.exec('PRAGMA busy_timeout = 1')
    let checked = false
    vi.spyOn(NormativeDocumentRepository.prototype, 'get').mockImplementation(function (
      this: NormativeDocumentRepository,
      id,
    ) {
      checked = true
      expect(() =>
        raw.prepare('UPDATE normative_documents SET note = ? WHERE id = ?').run('blocked', id),
      ).toThrow(/locked/)
      expect(
        raw.prepare('SELECT COUNT(*) AS count FROM document_pages WHERE document_id = ?').get(id),
      ).toEqual({ count: 3 })
      return get.call(this, id)
    })
    expect(store.deleteDocumentCommand.execute(document.id)).toBe(true)
    expect(checked).toBe(true)
  })

  it('exposes only the old document/text to another connection until both DELETE statements commit', () => {
    const { store, raw, document, pages } = setup(),
      connection = (store as unknown as { db: DatabaseSync }).db
    raw.exec('PRAGMA busy_timeout = 1')
    let observed = 0
    // The probe runs after the text DELETE and before the final document DELETE.
    connection.function('observe_document_delete', () => {
      observed++
      expect(connection.isTransaction).toBe(true)
      expect(
        connection
          .prepare('SELECT COUNT(*) AS count FROM document_pages WHERE document_id = ?')
          .get(document.id),
      ).toEqual({ count: 0 })
      expect(
        raw
          .prepare('SELECT text FROM document_pages WHERE document_id = ? ORDER BY page')
          .all(document.id),
      ).toEqual(pages.map((text) => ({ text })))
      expect(
        raw
          .prepare('SELECT COUNT(*) AS count FROM normative_documents WHERE id = ?')
          .get(document.id),
      ).toEqual({ count: 1 })
      expect(() =>
        raw
          .prepare('UPDATE normative_documents SET note = ? WHERE id = ?')
          .run('blocked', document.id),
      ).toThrow(/locked/)
      return 1
    })
    raw.exec(
      'CREATE TRIGGER observe_delete BEFORE DELETE ON normative_documents BEGIN SELECT observe_document_delete(); END',
    )
    expect(store.deleteDocumentCommand.execute(document.id)).toBe(true)
    expect(observed).toBe(1)
    expect(raw.prepare('SELECT COUNT(*) AS count FROM document_pages').get()).toEqual({ count: 0 })
    expect(raw.prepare('SELECT COUNT(*) AS count FROM normative_documents').get()).toEqual({
      count: 0,
    })
  })

  it('keeps missing-id false, refuses nested BEGIN without rolling back the caller, and reopens after rollback', () => {
    const { store, raw, path, document, pages } = setup(),
      connection = (store as unknown as { db: DatabaseSync }).db
    expect(store.deleteDocumentCommand.execute(999)).toBe(false)
    expect(store.documentText.get(document.id)).toEqual(pages)
    connection.exec('BEGIN IMMEDIATE')
    connection
      .prepare('UPDATE normative_documents SET note = ? WHERE id = ?')
      .run('Caller input', document.id)
    expect(() => store.deleteDocumentCommand.execute(document.id)).toThrow(/transaction/)
    expect(connection.isTransaction).toBe(true)
    expect(store.documents.get(document.id)?.note).toBe('Caller input')
    expect(
      raw.prepare('SELECT note FROM normative_documents WHERE id = ?').get(document.id),
    ).toEqual({ note: document.note })
    connection.exec('ROLLBACK')
    const reopened = openTestApplication(path)
    try {
      expect(reopened.documents.get(document.id)).toEqual(document)
      expect(reopened.documentText.get(document.id)).toEqual(pages)
      expect(reopened.deleteDocumentCommand.execute(document.id)).toBe(true)
      expect(store.deleteDocumentCommand.execute(document.id)).toBe(false)
    } finally {
      reopened.runtime.close()
    }
  })

  it('keeps HTTP 403/500/409/200/404 and the cached text after a failed DELETE', async () => {
    const { store, raw, document, pages } = setup(),
      server = createHttpServer(store.runtime.http, 0)
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing address')
    const url = `http://127.0.0.1:${address.port}/api/documents/${document.id}`,
      remove = () => fetch(url, { method: 'DELETE', headers: { Origin: 'http://127.0.0.1:5173' } })
    expect((await fetch(url, { method: 'DELETE' })).status).toBe(403)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    raw.exec(
      "CREATE TRIGGER reject_http_delete BEFORE DELETE ON normative_documents BEGIN SELECT RAISE(ABORT, 'private synthetic failure'); END",
    )
    const failed = await remove()
    expect(failed.status).toBe(500)
    expect(await failed.json()).toEqual({ error: 'Внутренняя ошибка локального реестра.' })
    expect(store.documentText.get(document.id)).toEqual(pages)
    expect(store.documents.get(document.id)).toEqual(document)
    raw.exec('DROP TRIGGER reject_http_delete')
    store.parameterConfirmations.add(evidenceConfirmation({ documentId: document.id }))
    expect((await remove()).status).toBe(409)
    expect(store.documentText.get(document.id)).toEqual(pages)
    raw.prepare('DELETE FROM parameter_confirmations WHERE document_id = ?').run(document.id)
    const removed = await remove()
    expect(removed.status).toBe(200)
    expect(await removed.json()).toEqual({ deleted: document.id })
    expect((await remove()).status).toBe(404)
  })
})
