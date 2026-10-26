import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { DocumentMeta } from '../../src/domain/normative-documents'
import { buildPdf } from './pdf-fixture'

export const documentMeta = (partial: Partial<DocumentMeta> = {}): DocumentMeta => ({
  code: 'Учебный стандарт 90000',
  edition: '2030',
  title: 'Вымышленный документ',
  kind: 'signs',
  effectiveFrom: '2030-01-01',
  amendsId: null,
  note: '',
  actualCheckedAt: '',
  ...partial,
})
export function documentFile(text = 'Fictional document') {
  const pdf = buildPdf([[{ t: 'text', x: 40, y: 700, text }]])
  return { filename: 'fictional.pdf', pdf, sha256: createHash('sha256').update(pdf).digest('hex') }
}
export function seedDocumentBatch(db: DatabaseSync, id: number) {
  db.prepare(
    `INSERT INTO sign_catalog_batches
    (document_code, edition, pdf_sha256, zip_sha256, sign_count, imported_at, document_id)
    VALUES ('FICTIONAL', '2030', NULL, 'fictional-archive', 0, '2030-02-01T00:00:00.000Z', ?)`,
  ).run(id)
}
