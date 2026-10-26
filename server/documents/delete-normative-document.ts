import type { NormativeDocumentRepository } from './normative-document-repository.ts'
import type { DocumentTextRepository } from './document-text-repository.ts'
import type { ParameterConfirmationRepository } from '../parameters/confirmation-repository.ts'
import type { SignCatalogDocumentReferences } from '../signs/document-references.ts'
import type { TransactionRunner } from '../transaction-runner.ts'
import { DocumentInUse } from './errors.ts'

export class DeleteNormativeDocument {
  private readonly documents: Pick<NormativeDocumentRepository, 'get' | 'list' | 'delete'>
  private readonly text: Pick<DocumentTextRepository, 'delete'>
  private readonly confirmations: Pick<ParameterConfirmationRepository, 'countForDocument'>
  private readonly signs: Pick<SignCatalogDocumentReferences, 'countBatches'>
  private readonly transactions: TransactionRunner

  constructor(
    documents: Pick<NormativeDocumentRepository, 'get' | 'list' | 'delete'>,
    text: Pick<DocumentTextRepository, 'delete'>,
    confirmations: Pick<ParameterConfirmationRepository, 'countForDocument'>,
    signs: Pick<SignCatalogDocumentReferences, 'countBatches'>,
    transactions: TransactionRunner,
  ) {
    this.documents = documents
    this.text = text
    this.confirmations = confirmations
    this.signs = signs
    this.transactions = transactions
  }

  execute(id: number): boolean {
    return this.transactions.immediate(() => {
      if (!this.documents.get(id)) return false
      if (this.signs.countBatches(id))
        throw new DocumentInUse(
          'С этим документом сверен импорт каталога знаков: запись нужна для истории и не удаляется.',
        )
      if (this.documents.list().some((document) => document.amendsId === id))
        throw new DocumentInUse('Сначала удалите изменения, прикреплённые к этому документу.')
      if (this.confirmations.countForDocument(id))
        throw new DocumentInUse(
          'По этому документу подтверждены нормативные параметры: запись нужна для истории и не удаляется.',
        )
      this.text.delete(id)
      this.documents.delete(id)
      return true
    })
  }
}
