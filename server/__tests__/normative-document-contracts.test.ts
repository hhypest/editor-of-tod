import { openTestApplication } from './test-application'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { DocumentInUse } from '../documents/errors'
import { documentMeta, documentFile, seedDocumentBatch } from './normative-document-fixture'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})
function setup(clock: () => string = () => '2030-02-01T00:00:00.000Z') {
  const directory = mkdtempSync(join(tmpdir(), 'tod-document-contract-')),
    path = join(directory, 'registry.sqlite'),
    store = openTestApplication(path, clock),
    raw = new DatabaseSync(path)
  cleanups.push(() => {
    raw.close()
    store.runtime.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return { store, raw }
}

/** These contracts run on the original RegistryStore before the document transfer. */
describe('normative document storage owner contracts', () => {
  it('normalizes metadata, preserves exact PDF/source fields on update and calls the clock only on insert', () => {
    let calls = 0
    const clockContext = {}
    const receivers: unknown[] = []
    const { store } = setup(
        function (this: unknown) {
          calls++
          receivers.push(this)
          return '2030-02-01T00:00:00.000Z'
        }.bind(clockContext),
      ),
      file = documentFile()
    calls = 0
    const record = store.documentService.add(
      documentMeta({
        code: '  Учебный стандарт 90000  ',
        title: '  Учебный  ',
        note: '  Примечание  ',
      }),
      file.filename,
      file.pdf,
      file.sha256,
    )
    expect(calls).toBe(1)
    expect(receivers.at(-1)).toBe(clockContext)
    expect(record).toEqual({
      ...documentMeta({ title: 'Учебный', note: 'Примечание' }),
      id: 1,
      filename: file.filename,
      sha256: file.sha256,
      sizeBytes: file.pdf.byteLength,
      addedAt: '2030-02-01T00:00:00.000Z',
    })
    expect(Object.keys(record)).toEqual([
      'id',
      'code',
      'edition',
      'title',
      'kind',
      'effectiveFrom',
      'amendsId',
      'note',
      'actualCheckedAt',
      'filename',
      'sha256',
      'sizeBytes',
      'addedAt',
    ])
    expect(
      store.documentService.update(
        record.id,
        documentMeta({ edition: '2031', actualCheckedAt: '2030-01-30' }),
      ),
    ).toEqual({ ...record, ...documentMeta({ edition: '2031', actualCheckedAt: '2030-01-30' }) })
    expect(Buffer.from(store.documents.getPdf(record.id)!.pdf)).toEqual(file.pdf)
    expect(store.documents.findBySha(file.sha256)?.id).toBe(record.id)
    expect(store.documents.getPdf(999)).toBeNull()
    expect(store.documentService.update(999, documentMeta())).toBeNull()
    expect(() => store.documentService.update(999, documentMeta({ code: '' }))).toThrow()
    expect(calls).toBe(1)
  })

  it('keeps duplicate/self/missing/chain/dependants failures and sign-kind guard precedence', () => {
    const { store, raw } = setup(),
      file = documentFile(),
      base = store.documentService.add(documentMeta(), file.filename, file.pdf, file.sha256),
      second = documentFile('Fictional second'),
      other = store.documentService.add(documentMeta(), second.filename, second.pdf, second.sha256),
      third = documentFile('Fictional amendment'),
      amendment = store.documentService.add(
        documentMeta({ amendsId: base.id }),
        third.filename,
        third.pdf,
        third.sha256,
      )
    expect(() =>
      store.documentService.add(
        documentMeta({ amendsId: 999 }),
        file.filename,
        file.pdf,
        file.sha256,
      ),
    ).toThrow('Этот PDF уже есть в библиотеке.')
    expect(() =>
      store.documentService.update(base.id, documentMeta({ amendsId: base.id })),
    ).toThrow('Документ не может изменять сам себя.')
    expect(() => store.documentService.update(base.id, documentMeta({ amendsId: 999 }))).toThrow(
      'Изменяемый документ не найден',
    )
    expect(() =>
      store.documentService.update(other.id, documentMeta({ amendsId: amendment.id })),
    ).toThrow('а не к другому изменению')
    expect(() =>
      store.documentService.update(base.id, documentMeta({ amendsId: other.id })),
    ).toThrow('он не может сам быть изменением')
    seedDocumentBatch(raw, base.id)
    expect(() =>
      store.documentService.update(base.id, documentMeta({ kind: 'rules', amendsId: base.id })),
    ).toThrow('вид документа изменить нельзя')
    expect(
      store.documentService.update(base.id, documentMeta({ note: 'Учебная правка' }))?.note,
    ).toBe('Учебная правка')
    expect(() => store.documentService.update(base.id, documentMeta({ kind: 'rules' }))).toThrow(
      DocumentInUse,
    )
    expect(store.documents.get(base.id)?.kind).toBe('signs')
  })

  it('keeps single-statement insert/update rollback after a SQLite trigger failure', () => {
    const { store, raw } = setup(),
      file = documentFile()
    raw.exec(
      "CREATE TRIGGER reject_document AFTER INSERT ON normative_documents BEGIN SELECT RAISE(ABORT, 'insert failed'); END",
    )
    expect(() =>
      store.documentService.add(documentMeta(), file.filename, file.pdf, file.sha256),
    ).toThrow('insert failed')
    expect(store.documents.list()).toEqual([])
    raw.exec('DROP TRIGGER reject_document')
    const record = store.documentService.add(documentMeta(), file.filename, file.pdf, file.sha256),
      before = raw.prepare('SELECT * FROM normative_documents').all()
    raw.exec(
      "CREATE TRIGGER reject_update AFTER UPDATE ON normative_documents BEGIN SELECT RAISE(ABORT, 'update failed'); END",
    )
    expect(() =>
      store.documentService.update(record.id, documentMeta({ edition: '2031' })),
    ).toThrow('update failed')
    expect(raw.prepare('SELECT * FROM normative_documents').all()).toEqual(before)
    raw.exec('DROP TRIGGER reject_update')
    expect(
      store.documentService.update(record.id, documentMeta({ edition: '2031' }))?.edition,
    ).toBe('2031')
  })
})
