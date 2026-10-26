import type { Pu66ImportService } from './pu66/import-service.ts'
import type { SignCatalogRepository } from './signs/catalog-repository.ts'

/** Commands used by the existing CLI; no HTTP or storage lifecycle. */
export interface ImportCliStorage {
  readonly backupDirectory: string
  planPu66: Pu66ImportService['plan']
  importPu66: Pu66ImportService['record']
  planSigns: SignCatalogRepository['plan']
  importSigns: SignCatalogRepository['import']
  createBackup(): Promise<string>
}
