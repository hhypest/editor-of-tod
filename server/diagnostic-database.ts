import { existsSync, readdirSync, statSync } from 'node:fs'

/** Read-only projections needed by diagnostics; no storage facade or connection. */
export interface DiagnosticDatabaseQueries {
  readonly path: string
  readonly backupDirectory: string
  schemaVersion(): number
  listPu66(): readonly unknown[]
  listProjects(): readonly unknown[]
  listRecoveries(): readonly unknown[]
  listDocuments(): readonly unknown[]
  listParameterConfirmations(): readonly unknown[]
  latestSignCatalog(): { signCount: number; documentId: number | null; importedAt: string } | null
}

/** Сводка базы: версии и количества, без содержимого записей. */
export function databaseSummary(store: DiagnosticDatabaseQueries): Record<string, unknown> {
  const safe = <T>(read: () => T): T | 'недоступно' => {
    try {
      return read()
    } catch {
      return 'недоступно'
    }
  }
  const catalog = safe(() => store.latestSignCatalog())
  return {
    location: store.path === ':memory:' ? 'память' : 'локальная база',
    sizeKb: safe(() =>
      store.path === ':memory:' ? 0 : Math.round(statSync(store.path).size / 1024),
    ),
    schemaVersion: safe(() => store.schemaVersion()),
    pu66Cards: safe(() => store.listPu66().length),
    projects: safe(() => store.listProjects().length),
    recoveryCopies: safe(() => store.listRecoveries().length),
    documents: safe(() => store.listDocuments().length),
    parameterConfirmations: safe(() => store.listParameterConfirmations().length),
    signCatalog:
      catalog && catalog !== 'недоступно'
        ? {
            signCount: catalog.signCount,
            fromPdf: catalog.documentId !== null,
            importedAt: catalog.importedAt,
          }
        : catalog,
    backups: safe(() =>
      existsSync(store.backupDirectory) ? readdirSync(store.backupDirectory).length : 0,
    ),
  }
}
