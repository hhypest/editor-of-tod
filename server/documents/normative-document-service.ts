import {
  documentMetaSchema,
  type DocumentMeta,
  type DocumentRecord,
} from '../../src/domain/normative-documents.ts'
import type { NormativeDocumentRepository } from './normative-document-repository.ts'
import { DocumentInUse } from './errors.ts'

export class NormativeDocumentService {
  private readonly documents: Pick<
    NormativeDocumentRepository,
    'list' | 'get' | 'findBySha' | 'insert' | 'update'
  >
  private readonly countSignBatches: (documentId: number) => number

  constructor(
    documents: Pick<
      NormativeDocumentRepository,
      'list' | 'get' | 'findBySha' | 'insert' | 'update'
    >,
    countSignBatches: (documentId: number) => number,
  ) {
    this.documents = documents
    this.countSignBatches = countSignBatches
  }

  private checkAmends(meta: DocumentMeta, selfId: number | null): void {
    if (meta.amendsId === null) return
    if (meta.amendsId === selfId) throw new DocumentInUse('Документ не может изменять сам себя.')
    const base = this.documents.get(meta.amendsId)
    if (!base) throw new DocumentInUse('Изменяемый документ не найден в библиотеке.')
    if (base.amendsId !== null)
      throw new DocumentInUse(
        'Изменение прикрепляется к основному документу, а не к другому изменению.',
      )
    if (selfId !== null) {
      const dependants = this.documents.list().filter((item) => item.amendsId === selfId)
      if (dependants.length)
        throw new DocumentInUse(
          'К этому документу прикреплены изменения: он не может сам быть изменением.',
        )
    }
  }

  add(input: DocumentMeta, filename: string, pdf: Uint8Array, sha256: string): DocumentRecord {
    const meta = documentMetaSchema.parse(input)
    if (this.documents.findBySha(sha256)) throw new DocumentInUse('Этот PDF уже есть в библиотеке.')
    this.checkAmends(meta, null)
    return this.documents.insert(meta, filename, pdf, sha256)
  }

  update(id: number, input: DocumentMeta): DocumentRecord | null {
    const meta = documentMetaSchema.parse(input)
    const existing = this.documents.get(id)
    if (!existing) return null
    if (existing.kind !== meta.kind) {
      // A historical sign batch must keep its document's kind.
      if (this.countSignBatches(id))
        throw new DocumentInUse(
          'С этим документом сверен импорт каталога знаков: вид документа изменить нельзя.',
        )
    }
    this.checkAmends(meta, id)
    return this.documents.update(id, meta)
  }
}
