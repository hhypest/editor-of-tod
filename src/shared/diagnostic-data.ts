/** Общий безопасный формат диагностики для браузера и локального сервера. */
export const diagnosticErrorTypes = [
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'URIError',
  'EvalError',
  'AggregateError',
  'ZodError',
  'NonError',
] as const
export type DiagnosticErrorType = (typeof diagnosticErrorTypes)[number]

export function safeErrorType(value: unknown): DiagnosticErrorType {
  return diagnosticErrorTypes.includes(value as DiagnosticErrorType)
    ? (value as DiagnosticErrorType)
    : 'Error'
}

const operationNames = new Set([
  'Ошибка в окне',
  'Необработанный отказ обещания',
  'Ошибка Vue',
  'Открытие JSON-проекта',
  'Операция с локальной базой',
  'Проверка документа',
  'Добавление документа',
  'Выгрузка листа PNG',
  'Просмотр ZIP знаков',
  'Запись ZIP знаков',
  'Просмотр импорта ПУ-66',
  'Импорт ПУ-66',
  'Извлечение знаков из PDF',
  'Запись каталога знаков из PDF',
  'Другое действие',
])
export function diagnosticOperation(value: string): string {
  if (value.startsWith('Ошибка Vue (')) return 'Ошибка Vue'
  return operationNames.has(value) ? value : 'Другое действие'
}

/** Только известные места программы: ни имена функций, ни корень диска, ни файлы пользователя. */
const programFiles = new Set([
  'scripts/build-exe.mjs',
  'scripts/check-node-entrypoints.mjs',
  'scripts/check-public-files.mjs',
  'scripts/generate-pu66-samples.ts',
  'scripts/third-party-licenses.ts',
  'server/app-paths.ts',
  'server/backup-cli.ts',
  'server/backup-retention.ts',
  'server/database-identity.ts',
  'server/desktop-instance.ts',
  'server/desktop.ts',
  'server/diagnostics.ts',
  'server/document-web-import.ts',
  'server/import-cli.ts',
  'server/index.ts',
  'server/normative-parameters.ts',
  'server/pdf-text.ts',
  'server/pdfjs-worker.d.ts',
  'server/pdfjs.ts',
  'server/pu66-web-import.ts',
  'server/pu66-lifecycle.ts',
  'server/pu66.ts',
  'server/sign-pdf-import.ts',
  'server/sign-pdf.ts',
  'server/sign-web-import.ts',
  'server/signs.ts',
  'server/store.ts',
  'src/App.vue',
  'src/components/AboutProgram.vue',
  'src/components/DiagnosticsPanel.vue',
  'src/components/HelpPage.vue',
  'src/components/ImportedData.vue',
  'src/components/LocalProjects.vue',
  'src/components/LocalRegistries.vue',
  'src/components/NewScheme.vue',
  'src/components/NormativeDocuments.vue',
  'src/components/NormativeMark.vue',
  'src/components/NormativeParameters.vue',
  'src/components/PdfSignCatalog.vue',
  'src/components/PlacementEditor.vue',
  'src/components/ProjectDataInspector.vue',
  'src/components/Pu66CardPicker.vue',
  'src/components/Pu66Linker.vue',
  'src/components/Pu66Lifecycle.vue',
  'src/components/Pu66NormsPanel.vue',
  'src/components/RoadworkSymbol.vue',
  'src/components/SchemeDetailsEditor.vue',
  'src/components/SchemeDraftSheet.vue',
  'src/components/SchemeReview.vue',
  'src/components/SchemeWorkspace.vue',
  'src/components/SheetNodes.vue',
  'src/components/SheetSign.vue',
  'src/components/SignPreview.vue',
  'src/components/TemplateChoice.vue',
  'src/application/recovery-session.ts',
  'src/application/recovery-contract.ts',
  'src/composables/useNormativeRules.ts',
  'src/composables/usePu66Status.ts',
  'src/composables/useProjectSession.ts',
  'src/domain/create-scheme.ts',
  'src/domain/document-text.ts',
  'src/domain/draft-sheet.ts',
  'src/domain/edit-details.ts',
  'src/domain/edit-history.ts',
  'src/domain/edit-placements.ts',
  'src/domain/figure-dimensions.ts',
  'src/domain/import.ts',
  'src/domain/legacy-v1.ts',
  'src/domain/link-pu66.ts',
  'src/domain/local-projects.ts',
  'src/domain/model.ts',
  'src/domain/normative-defaults.ts',
  'src/domain/normative-documents.ts',
  'src/domain/normative-parameters.ts',
  'src/domain/placement-labels.ts',
  'src/domain/placement-workspace.ts',
  'src/domain/pu66-norms.ts',
  'src/domain/pu66-review.ts',
  'src/domain/pu66-lifecycle.ts',
  'src/domain/pu66-search.ts',
  'src/domain/pu66-snapshot.ts',
  'src/domain/recovery.ts',
  'src/domain/registry.ts',
  'src/domain/regulation-advice.ts',
  'src/domain/release-readiness.ts',
  'src/domain/review-marks.ts',
  'src/domain/review-scheme.ts',
  'src/domain/sheet-drawing.ts',
  'src/domain/sign-images.ts',
  'src/domain/template-placements.ts',
  'src/domain/title-block.ts',
  'src/help/help-content.ts',
  'src/main.ts',
  'src/services/diagnostics.ts',
  'src/services/json-response.ts',
  'src/services/local-documents.ts',
  'src/services/local-normatives.ts',
  'src/services/local-projects.ts',
  'src/services/local-pu66.ts',
  'src/services/local-signs.ts',
  'src/services/sheet-png.ts',
  'server.cjs',
])

export function diagnosticFrames(stack: unknown): string[] {
  if (typeof stack !== 'string') return []
  const frames: string[] = []
  for (const line of stack.split('\n')) {
    const match =
      /(?:^|[/(@])((?:src|server|scripts)\/[^()\s:?]+|assets\/index-[A-Za-z0-9_-]+\.js|server\.cjs):(\d{1,7}):(\d{1,7})\)?$/.exec(
        line.trim().replaceAll('\\', '/'),
      )
    if (!match) continue
    const file = match[1]!
    if (!programFiles.has(file) && !/^assets\/index-[A-Za-z0-9_-]{6,30}\.js$/.test(file)) continue
    frames.push(`${file}:${match[2]}:${match[3]}`)
    if (frames.length === 4) break
  }
  return frames
}

export function diagnosticError(error: unknown): {
  errorType: DiagnosticErrorType
  frames: string[]
} {
  return error instanceof Error
    ? { errorType: safeErrorType(error.name), frames: diagnosticFrames(error.stack) }
    : { errorType: 'NonError', frames: [] }
}
