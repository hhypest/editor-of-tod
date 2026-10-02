import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { arch, platform, release, totalmem } from 'node:os'
import { z } from 'zod'
import {
  describeDiagnosticError,
  diagnosticOperation,
  sanitizeErrorDescription,
} from '../src/domain/diagnostic-errors.ts'
import type { RegistryStore } from './store.ts'

/**
 * Диагностика для отладки: журнал ошибок и медленных операций, статистика запросов и сводка
 * состояния базы. Всё хранится локально (файл `diagnostics.jsonl` рядом с базой) и
 * выгружается только по кнопке «Скачать диагностику». В журнал и отчёт не попадают данные
 * ПУ-66 и содержимое проектов: маршруты обобщаются, свободный текст ошибок и абсолютные
 * пути не записываются. Допускаются только типы ошибок и позиции в известных модулях.
 */

export type DiagnosticEvent = {
  at: string
  source: 'server' | 'client'
  kind: 'error' | 'slow' | 'timing' | 'event'
  name: string
  durationMs?: number
  status?: number
  message?: string
}

/** Сколько событий хранить; при превышении файл переписывается последними событиями. */
const MAX_EVENTS = 1_000
const KEEP_AFTER_ROTATION = 600
/** Запрос медленнее этого порога записывается в журнал. */
export const SLOW_REQUEST_MS = 1_500

const text = (max: number) => z.string().trim().min(1).max(max)
export const clientEventsSchema = z.strictObject({
  events: z
    .array(
      z.strictObject({
        kind: z.enum(['error', 'timing', 'event']),
        name: text(120),
        durationMs: z.number().finite().nonnegative().max(86_400_000).optional(),
        message: z.string().max(2_000).optional(),
      }),
    )
    .min(1)
    .max(20),
})

/** Адрес запроса без ключей и идентификаторов: `/api/pu66/:key/norms`, `/api/projects/:id`. */
export function routeOf(method: string, pathname: string): string {
  if (!pathname.startsWith('/api/'))
    return `${['GET', 'HEAD'].includes(method) ? method : 'UNKNOWN'} (интерфейс)`
  const route = pathname
    .replace(/^\/api\/pu66\/(?!import\/)[^/]+/u, '/api/pu66/:key')
    .replace(/^\/api\/projects\/[^/]+/u, '/api/projects/:id')
    .replace(/\/revisions\/\d+$/u, '/revisions/:n')
    .replace(/^\/api\/recovery\/[^/]+/u, '/api/recovery/:id')
    .replace(/^\/api\/documents\/\d+/u, '/api/documents/:id')
    .replace(/^\/api\/signs\/(?!import\/)[^/]+\/image$/u, '/api/signs/:code/image')
    .replace(/^\/api\/crossings\/[^/]+/u, '/api/crossings/:key')
    .replace(/^\/api\/normative-parameters\/[^/]+/u, '/api/normative-parameters/:id')
  const safeMethod = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'].includes(method)
    ? method
    : 'UNKNOWN'
  return `${safeMethod} ${knownRoutes.has(route) ? route : '(неизвестный маршрут)'}`
}

const knownRoutes = new Set([
  '/api/status',
  '/api/diagnostics',
  '/api/diagnostics/events',
  '/api/diagnostics/clear',
  '/api/crossings',
  '/api/crossings/:key',
  '/api/normative',
  '/api/pu66',
  '/api/pu66/import/preview',
  '/api/pu66/import/apply',
  '/api/pu66/:key/norms',
  '/api/pu66/:key/scheme',
  '/api/pu66/:key/verifications',
  '/api/pu66/:key/verification',
  '/api/projects',
  '/api/projects/:id',
  '/api/projects/:id/revisions',
  '/api/projects/:id/revisions/:n',
  '/api/recovery',
  '/api/recovery/:id',
  '/api/signs',
  '/api/signs/catalog',
  '/api/signs/:code/image',
  '/api/signs/import/preview',
  '/api/signs/import/apply',
  '/api/normative-parameters',
  '/api/normative-parameters/:id/confirm',
  '/api/documents',
  '/api/documents/preview',
  '/api/documents/apply',
  '/api/documents/:id',
  '/api/documents/:id/pdf',
  '/api/documents/:id/signs/preview',
  '/api/documents/:id/signs/apply',
  '/api/documents/:id/signs/image',
  '/api/backup',
])

function safeRoute(route: string): string {
  const [method, pathname] = route.split(' ')
  if (pathname === '(интерфейс)' || pathname === '(неизвестный') {
    const safeMethod = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'].includes(
      method ?? '',
    )
      ? method
      : 'UNKNOWN'
    return `${safeMethod} ${pathname === '(интерфейс)' ? '(интерфейс)' : '(неизвестный маршрут)'}`
  }
  return routeOf(method ?? 'UNKNOWN', pathname ?? '/api/?')
}

const storedEventSchema = z.object({
  at: z.iso.datetime(),
  source: z.enum(['server', 'client']),
  kind: z.enum(['error', 'slow', 'timing', 'event']),
  name: z.string(),
  durationMs: z.number().finite().nonnegative().optional(),
  status: z.number().int().min(100).max(599).optional(),
  message: z.string().optional(),
})

function safeEvent(event: DiagnosticEvent): DiagnosticEvent {
  return {
    at: event.at,
    source: event.source,
    kind: event.kind,
    name: event.source === 'server' ? safeRoute(event.name) : diagnosticOperation(event.name),
    ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
    ...(event.status === undefined ? {} : { status: event.status }),
    ...(event.message === undefined ? {} : { message: sanitizeErrorDescription(event.message) }),
  }
}

type RouteStats = { count: number; errors: number; totalMs: number; maxMs: number }

export class DiagnosticsLog {
  private events: DiagnosticEvent[] = []
  private readonly routes = new Map<string, RouteStats>()
  private readonly startedAt: string

  /** Файл журнала; null — только в памяти (тесты). */
  private readonly file: string | null
  readonly app: { version: string; mode: string }
  private readonly now: () => string

  // Свойства задаются явно: сервер запускается Node.js без компиляции TypeScript.
  constructor(
    file: string | null,
    app: { version: string; mode: string },
    now: () => string = () => new Date().toISOString(),
  ) {
    this.file = file
    this.app = app
    this.now = now
    this.startedAt = now()
    if (file && existsSync(file)) {
      try {
        this.events = readFileSync(file, 'utf8')
          .split('\n')
          .filter(Boolean)
          .slice(-MAX_EVENTS)
          .flatMap((line) => {
            try {
              const result = storedEventSchema.safeParse(JSON.parse(line))
              return result.success ? [safeEvent(result.data)] : []
            } catch {
              return []
            }
          })
        // Миграция старого журнала: свободный текст удаляется и из файла на диске.
        writeFileSync(file, this.events.map((item) => JSON.stringify(item)).join('\n') + '\n', {
          mode: 0o600,
        })
      } catch {
        this.events = []
      }
    }
  }

  record(event: Omit<DiagnosticEvent, 'at'>): void {
    const entry = safeEvent({ ...event, at: this.now() })
    this.events.push(entry)
    if (!this.file) {
      if (this.events.length > MAX_EVENTS) this.events = this.events.slice(-KEEP_AFTER_ROTATION)
      return
    }
    try {
      if (this.events.length > MAX_EVENTS) {
        this.events = this.events.slice(-KEEP_AFTER_ROTATION)
        writeFileSync(
          this.file,
          this.events.map((item) => JSON.stringify(item)).join('\n') + '\n',
          {
            mode: 0o600,
          },
        )
      } else {
        appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
      }
    } catch {
      // Журнал — вспомогательный: ошибка записи не должна мешать работе редактора.
    }
  }

  /** Учёт запроса: статистика по адресу; ошибки и медленные запросы — в журнал. */
  request(route: string, status: number, durationMs: number): void {
    route = safeRoute(route)
    const stats = this.routes.get(route) ?? { count: 0, errors: 0, totalMs: 0, maxMs: 0 }
    stats.count++
    if (status >= 400) stats.errors++
    stats.totalMs += durationMs
    stats.maxMs = Math.max(stats.maxMs, durationMs)
    this.routes.set(route, stats)
    if (status >= 500) return // Подробности внутренней ошибки записывает обработчик.
    if (status >= 400)
      this.record({ source: 'server', kind: 'error', name: route, status, durationMs })
    else if (durationMs >= SLOW_REQUEST_MS)
      this.record({ source: 'server', kind: 'slow', name: route, status, durationMs })
  }

  serverError(route: string, error: unknown): void {
    const message = describeDiagnosticError(error)
    this.record({ source: 'server', kind: 'error', name: route, status: 500, message })
  }

  clear(): void {
    this.events = []
    this.routes.clear()
    if (this.file) {
      try {
        writeFileSync(this.file, '', { mode: 0o600 })
      } catch {
        // См. record().
      }
    }
  }

  /** Отчёт для разработчика: среда, сводка базы, статистика запросов и журнал событий. */
  report(store: RegistryStore): Record<string, unknown> {
    const routes = [...this.routes.entries()]
      .map(([route, stats]) => ({
        route,
        count: stats.count,
        errors: stats.errors,
        averageMs: Math.round(stats.totalMs / stats.count),
        maxMs: Math.round(stats.maxMs),
      }))
      .sort((a, b) => b.count - a.count)
    return {
      kind: 'editor-of-tod-diagnostics',
      formatVersion: 2,
      generatedAt: this.now(),
      note: 'Содержимое документов, ПУ-66 и проектов не включается. Ошибки содержат только тип и позиции в коде; пути и свободный текст исключены. Проверьте отчёт перед отправкой.',
      app: {
        ...this.app,
        serverStartedAt: this.startedAt,
        uptimeSeconds: Math.round(process.uptime()),
      },
      environment: {
        node: process.version,
        platform: platform(),
        osRelease: release(),
        arch: arch(),
        totalMemoryMb: Math.round(totalmem() / 1024 / 1024),
        processMemoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      },
      database: databaseSummary(store),
      requests: routes,
      events: this.events.slice(-300),
      eventsTotal: this.events.length,
    }
  }
}

/** Сводка базы: версии и количества, без содержимого записей. */
export function databaseSummary(store: RegistryStore): Record<string, unknown> {
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
