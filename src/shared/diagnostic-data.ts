import { diagnosticProgramFiles } from './diagnostic-files.generated.ts'

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
  'Извлечение знаков из ГОСТ',
  'Запись каталога знаков из PDF',
  'Другое действие',
])
export function diagnosticOperation(value: string): string {
  if (value.startsWith('Ошибка Vue (')) return 'Ошибка Vue'
  return operationNames.has(value) ? value : 'Другое действие'
}

/** Только известные места программы: ни имена функций, ни корень диска, ни файлы пользователя. */
const programFiles = new Set<string>(diagnosticProgramFiles)

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
