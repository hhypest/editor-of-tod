/** Только известные модули программы: имена файлов и функции из произвольного стека запрещены. */
const codePaths = new Set(
  `
server/app-paths.ts
server/backup-cli.ts
server/backup-retention.ts
server/desktop-instance.ts
server/desktop.ts
server/diagnostics.ts
server/document-web-import.ts
server/import-cli.ts
server/index.ts
server/normative-parameters.ts
server/pdf-text.ts
server/pdfjs-worker.d.ts
server/pdfjs.ts
server/pu66-web-import.ts
server/pu66.ts
server/sign-pdf-import.ts
server/sign-pdf.ts
server/sign-web-import.ts
server/signs.ts
server/store.ts
src/App.vue
src/components/AboutProgram.vue
src/components/DiagnosticsPanel.vue
src/components/HelpPage.vue
src/components/ImportedData.vue
src/components/LocalProjects.vue
src/components/LocalRegistries.vue
src/components/NewScheme.vue
src/components/NormativeDocuments.vue
src/components/NormativeMark.vue
src/components/NormativeParameters.vue
src/components/PdfSignCatalog.vue
src/components/PlacementEditor.vue
src/components/ProjectDataInspector.vue
src/components/Pu66CardPicker.vue
src/components/Pu66Linker.vue
src/components/Pu66NormsPanel.vue
src/components/RoadworkSymbol.vue
src/components/SchemeDetailsEditor.vue
src/components/SchemeDraftSheet.vue
src/components/SchemeReview.vue
src/components/SchemeWorkspace.vue
src/components/SheetNodes.vue
src/components/SheetSign.vue
src/components/SignPreview.vue
src/components/TemplateChoice.vue
src/composables/useNormativeRules.ts
src/composables/useProjectSession.ts
src/domain/create-scheme.ts
src/domain/document-text.ts
src/domain/diagnostic-errors.ts
src/domain/draft-sheet.ts
src/domain/edit-details.ts
src/domain/edit-history.ts
src/domain/edit-placements.ts
src/domain/figure-dimensions.ts
src/domain/import.ts
src/domain/legacy-v1.ts
src/domain/link-pu66.ts
src/domain/local-projects.ts
src/domain/model.ts
src/domain/normative-defaults.ts
src/domain/normative-documents.ts
src/domain/normative-parameters.ts
src/domain/placement-labels.ts
src/domain/placement-workspace.ts
src/domain/pu66-norms.ts
src/domain/pu66-review.ts
src/domain/pu66-search.ts
src/domain/pu66-snapshot.ts
src/domain/recovery.ts
src/domain/registry.ts
src/domain/regulation-advice.ts
src/domain/release-readiness.ts
src/domain/review-marks.ts
src/domain/review-scheme.ts
src/domain/sheet-drawing.ts
src/domain/sign-images.ts
src/domain/template-placements.ts
src/domain/title-block.ts
src/help/help-content.ts
src/main.ts
src/services/diagnostics.ts
src/services/json-response.ts
src/services/local-documents.ts
src/services/local-normatives.ts
src/services/local-projects.ts
src/services/local-pu66.ts
src/services/local-signs.ts
src/services/sheet-png.ts
src/services/sign-image-url.ts
`
    .trim()
    .split(/\s+/),
)
const errorTypes = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'URIError',
  'EvalError',
  'AggregateError',
  'RequestError',
  'SchemeImportError',
  'ZodError',
])

/** Принимает и старое описание ошибки; свободный текст никогда не возвращается. */
export function sanitizeErrorDescription(description: string): string {
  const lines = description.split('\n')
  const candidate = lines[0]?.split(':')[0]?.trim() ?? ''
  const type = errorTypes.has(candidate) ? candidate : 'Error'
  const frames: string[] = []
  for (const line of lines.slice(1)) {
    // V8, Firefox и уже очищенные описания. Игнорируем функцию и абсолютный префикс.
    if (!/^\s*at\s|@/.test(line)) continue
    const match = line.replaceAll('\\', '/').match(/([^\s()]+):(\d{1,8}):(\d{1,8})\)?$/)
    if (!match) continue
    const [, path, row, column] = match
    const module = [...codePaths].find((known) => path === known || path?.endsWith('/' + known))
    const bundle = /(?:^|\/)app\.cjs$/.test(path!)
      ? 'app.cjs'
      : /(?:^|\/)assets\/index-[a-zA-Z0-9_-]+\.js$/.test(path!)
        ? 'assets/index.js'
        : undefined
    // После повторной серверной очистки имя браузерного bundle уже обобщено.
    const safePath = module ?? bundle ?? (path === 'assets/index.js' ? path : undefined)
    if (safePath) frames.push(`at ${safePath}:${row}:${column}`)
    if (frames.length === 4) break
  }
  return [type, ...frames].join('\n')
}

export function describeDiagnosticError(error: unknown): string {
  if (!(error instanceof Error)) return 'Error'
  // Не используем первую строку стека: она содержит message, иногда с переводами строк.
  const frames = (error.stack ?? '').split('\n').slice(1).join('\n')
  return sanitizeErrorDescription(`${errorTypes.has(error.name) ? error.name : 'Error'}\n${frames}`)
}

const operationNames = new Set([
  'Импорт ПУ-66',
  'Просмотр импорта ПУ-66',
  'Просмотр ZIP знаков',
  'Запись ZIP знаков',
  'Извлечение знаков из PDF',
  'Запись каталога знаков из PDF',
  'Проверка документа',
  'Добавление документа',
  'Выгрузка листа PNG',
  'Открытие JSON-проекта',
  'Операция с локальной базой',
  'Ошибка в окне',
  'Необработанный отказ обещания',
  'Ошибка Vue',
])

/** Название операции задаёт программа, а не загруженный файл или исключение. */
export function diagnosticOperation(name: string): string {
  return operationNames.has(name) ? name : 'Событие интерфейса'
}
