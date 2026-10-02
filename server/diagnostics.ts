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
import type { RegistryStore } from './store.ts'
import {
  diagnosticError,
  diagnosticErrorTypes,
  diagnosticFrames,
  diagnosticOperation,
  safeErrorType,
  type DiagnosticErrorType,
} from '../src/shared/diagnostic-data.ts'

/** Локальная диагностика: только типы ошибок, известные операции и обезличенные места кода. */

export type DiagnosticEvent = {
  at: string
  source: 'server' | 'client'
  kind: 'error' | 'slow' | 'timing' | 'event'
  name: string
  durationMs?: number
  status?: number
  errorType?: DiagnosticErrorType
  frames?: string[]
  /** Текст интерфейса строится только из безопасных типа и мест кода. */
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
        // Совместимость со старым клиентом: сообщение принимается, но не записывается.
        message: z.string().max(2_000).optional(),
        errorType: z.enum(diagnosticErrorTypes).optional(),
        frames: z.array(z.string().max(2_000)).max(4).optional(),
      }),
    )
    .min(1)
    .max(20),
})

const fixedRoutes = new Set([
  '/api/status',
  '/api/diagnostics',
  '/api/diagnostics/events',
  '/api/diagnostics/clear',
  '/api/crossings',
  '/api/normative',
  '/api/pu66',
  '/api/pu66/import/preview',
  '/api/pu66/import/apply',
  '/api/projects',
  '/api/recovery',
  '/api/signs',
  '/api/signs/catalog',
  '/api/signs/import/preview',
  '/api/signs/import/apply',
  '/api/normative-parameters',
  '/api/documents',
  '/api/documents/preview',
  '/api/documents/apply',
  '/api/backup',
])
const dynamicRoutes: Array<[RegExp, string]> = [
  [/^\/api\/pu66\/[^/]+\/(norms|scheme|verification|verifications)$/, '/api/pu66/:key/$1'],
  [/^\/api\/projects\/[^/]+\/revisions\/(?:\d+|:n)$/, '/api/projects/:id/revisions/:n'],
  [/^\/api\/projects\/[^/]+(\/(?:revisions|restore))?$/, '/api/projects/:id$1'],
  [/^\/api\/recovery\/[^/]+$/, '/api/recovery/:id'],
  [
    /^\/api\/documents\/(?:\d+|:id)(\/(?:pdf|signs\/(?:preview|apply|image)))?$/,
    '/api/documents/:id$1',
  ],
  [/^\/api\/signs\/[^/]+\/image$/, '/api/signs/:code/image'],
  [/^\/api\/crossings\/[^/]+$/, '/api/crossings/:key'],
  [/^\/api\/normative-parameters\/[^/]+(\/confirm)?$/, '/api/normative-parameters/:id$1'],
]

/** Никакая неизвестная часть URL, включая суффикс и параметры, не попадает в журнал. */
export function routeOf(method: string, pathname: string): string {
  const verb = /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/.test(method) ? method : 'OTHER'
  if (!pathname.startsWith('/api/')) return `${verb} (интерфейс)`
  if (fixedRoutes.has(pathname)) return `${verb} ${pathname}`
  for (const [pattern, replacement] of dynamicRoutes)
    if (pattern.test(pathname)) return `${verb} ${pathname.replace(pattern, replacement)}`
  return `${verb} (неизвестный API)`
}

function safeRoute(value: string): string {
  const match = /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|OTHER) (.+)$/.exec(value)
  if (!match) return 'OTHER (неизвестный API)'
  if (['(интерфейс)', '(неизвестный API)'].includes(match[2]!)) return value
  return routeOf(match[1]!, match[2]!)
}

const storedEventSchema = z.object({
  at: z.iso.datetime(),
  source: z.enum(['server', 'client']),
  kind: z.enum(['error', 'slow', 'timing', 'event']),
  name: z.string().max(2_000),
  durationMs: z.number().finite().nonnegative().max(86_400_000).optional(),
  status: z.number().int().min(100).max(599).optional(),
  errorType: z.string().max(120).optional(),
  frames: z.array(z.string().max(2_000)).max(4).optional(),
})

/** Одинаковая защита для новых событий, недоверенного клиента и журнала прежних версий. */
function safeEvent(value: unknown): DiagnosticEvent | null {
  const parsed = storedEventSchema.safeParse(value)
  if (!parsed.success) return null
  const { data } = parsed
  const frames = diagnosticFrames(data.frames?.join('\n'))
  const errorType = data.errorType === undefined ? undefined : safeErrorType(data.errorType)
  return {
    at: data.at,
    source: data.source,
    kind: data.kind,
    name: data.source === 'server' ? safeRoute(data.name) : diagnosticOperation(data.name),
    ...(data.status === undefined ? {} : { status: data.status }),
    ...(data.durationMs === undefined ? {} : { durationMs: data.durationMs }),
    ...(errorType === undefined
      ? {}
      : {
          errorType,
          frames,
          message: [errorType, ...frames].join('\n'),
        }),
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
              const event = safeEvent(JSON.parse(line))
              return event ? [event] : []
            } catch {
              return []
            }
          })
        // Удаляем свободные сообщения прежних версий и с диска, не только из выгрузки.
        writeFileSync(
          file,
          this.events.map((event) => JSON.stringify(event)).join('\n') +
            (this.events.length ? '\n' : ''),
          { mode: 0o600 },
        )
      } catch {
        this.events = []
      }
    }
  }

  record(event: Omit<DiagnosticEvent, 'at'>): void {
    const entry = safeEvent({ ...event, at: this.now() })
    if (!entry) return
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
    this.record({
      source: 'server',
      kind: 'error',
      name: route,
      status: 500,
      ...diagnosticError(error),
    })
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
      note: 'Диагностика содержит только техническую сводку, известные операции, типы ошибок и места в коде программы. Тексты ошибок, абсолютные пути и содержимое пользовательских записей не включены. Проверьте отчёт перед отправкой.',
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
