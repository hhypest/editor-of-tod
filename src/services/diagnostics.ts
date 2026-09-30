import type { App } from 'vue'

/**
 * Диагностика в браузере: ошибки интерфейса и время долгих операций отправляются в локальный
 * журнал (`/api/diagnostics/events`) пачками. Ничего не уходит за пределы компьютера. В
 * события передаются только названия операций, длительность и текст ошибки — сервер
 * дополнительно очищает его от ключей ПУ-66, телефонов и ФИО.
 */

type ClientEvent = {
  kind: 'error' | 'timing' | 'event'
  name: string
  durationMs?: number
  message?: string
}

declare const __APP_BUILD__: { version: string; commit: string; builtAt: string } | undefined

export const appBuild =
  typeof __APP_BUILD__ === 'object' && __APP_BUILD__
    ? __APP_BUILD__
    : { version: 'dev', commit: 'unknown', builtAt: '' }

const queue: ClientEvent[] = []
let timer: ReturnType<typeof setTimeout> | null = null
/** Защита от лавины одинаковых ошибок (например, в цикле отрисовки). */
const recent = new Map<string, number>()

function schedule(): void {
  if (timer) return
  timer = setTimeout(() => void flush(), 1_000)
}

export async function flush(): Promise<void> {
  timer = null
  while (queue.length) {
    const events = queue.splice(0, 20)
    try {
      await fetch('/api/diagnostics/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events }),
        keepalive: true,
      })
    } catch {
      // Локальный API недоступен — событие теряется, работа не прерывается.
      return
    }
  }
}

function push(event: ClientEvent): void {
  const key = `${event.kind}|${event.name}|${event.message ?? ''}`
  const now = Date.now()
  if (event.kind === 'error' && now - (recent.get(key) ?? 0) < 10_000) return
  recent.set(key, now)
  queue.push({
    ...event,
    name: event.name.slice(0, 120),
    ...(event.message === undefined ? {} : { message: event.message.slice(0, 2_000) }),
  })
  if (queue.length > 200) queue.splice(0, queue.length - 200)
  schedule()
}

/**
 * Описание ошибки для журнала. `withText: false` — только тип и стек: текст ошибок операций с
 * файлами и базой может содержать имя книги ПУ-66, название станции или ключ переезда, а
 * серверная очистка распознаёт лишь ключи, телефоны и ФИО. Первая строка стека V8 повторяет
 * сообщение, поэтому она отбрасывается.
 */
function describe(error: unknown, withText: boolean): string {
  if (error instanceof Error) {
    const frames = (error.stack ?? '')
      .split('\n')
      .filter((line) => /^\s*at\s|@/.test(line))
      .slice(0, 4)
      .join('\n')
    return withText ? `${error.name}: ${error.message}\n${frames}` : `${error.name}\n${frames}`
  }
  return withText ? String(error) : typeof error
}

/**
 * Ошибка в журнал. Для ошибок кода (окно, Vue) текст полезен и записывается; для ошибок
 * операций с пользовательскими данными передайте `{ withText: false }`.
 */
export function reportError(
  name: string,
  error: unknown,
  options: { withText?: boolean } = {},
): void {
  push({ kind: 'error', name, message: describe(error, options.withText ?? true) })
}

export function reportEvent(name: string, message?: string): void {
  push({ kind: 'event', name, ...(message ? { message } : {}) })
}

/**
 * Замер долгой операции: длительность записывается в журнал вместе с исходом. Ошибка
 * операции записывается (тип и стек, без текста) и пробрасывается дальше без изменений.
 */
export async function timed<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const started = performance.now()
  try {
    const result = await operation()
    push({ kind: 'timing', name, durationMs: Math.round(performance.now() - started) })
    return result
  } catch (error) {
    push({
      kind: 'error',
      name,
      durationMs: Math.round(performance.now() - started),
      // Операции работают с файлами пользователя: текст ошибки не записывается.
      message: describe(error, false),
    })
    throw error
  }
}

/** Глобальные перехватчики ошибок окна и Vue; вызывается один раз при запуске. */
export function installDiagnostics(app: App): void {
  window.addEventListener('error', (event) =>
    reportError('Ошибка в окне', event.error ?? event.message),
  )
  window.addEventListener('unhandledrejection', (event) =>
    reportError('Необработанный отказ обещания', event.reason),
  )
  app.config.errorHandler = (error, _instance, info) => {
    reportError(`Ошибка Vue (${info})`, error)
    console.error(error)
  }
  window.addEventListener('pagehide', () => void flush())
}

export type DiagnosticsReport = Record<string, unknown>

export async function loadDiagnostics(): Promise<DiagnosticsReport> {
  await flush()
  const response = await fetch('/api/diagnostics')
  if (!response.ok) throw new Error('Локальный API не отдал диагностику.')
  return (await response.json()) as DiagnosticsReport
}

export async function clearDiagnostics(): Promise<void> {
  const response = await fetch('/api/diagnostics/clear', { method: 'POST' })
  if (!response.ok) throw new Error('Не удалось очистить журнал диагностики.')
}
