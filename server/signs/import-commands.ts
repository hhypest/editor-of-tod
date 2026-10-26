import type { DocumentRecord } from '../../src/domain/normative-documents.ts'
import type { SignImport } from '../signs.ts'
import type {
  SignCatalogRepository,
  SignCatalogSource,
  SignCatalogPlan,
} from './catalog-repository.ts'

export interface SignImportCommands {
  getDocument(id: number): DocumentRecord | null
  getDocumentPdf(id: number): { filename: string; pdf: Uint8Array } | null
  latestSignCatalog(): ReturnType<SignCatalogRepository['latest']>
  planSigns(entries: SignImport[], source?: SignCatalogSource): SignCatalogPlan
  importSigns(entries: SignImport[], source?: SignCatalogSource): SignCatalogPlan
  createBackup(): Promise<string>
}

export type SignImportRead = Pick<
  SignImportCommands,
  'getDocument' | 'getDocumentPdf' | 'latestSignCatalog' | 'planSigns'
>
