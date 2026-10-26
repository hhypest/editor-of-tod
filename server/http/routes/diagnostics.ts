import { clientEventsSchema, type DiagnosticsLog } from '../../diagnostics.ts'
import { json, readJson } from '../json.ts'
import type { RouteHandler } from '../route.ts'

export interface DiagnosticRouteDependencies extends Pick<DiagnosticsLog, 'record' | 'clear'> {
  report(): Record<string, unknown>
}

export function createDiagnosticRoutes(diagnostics: DiagnosticRouteDependencies): RouteHandler {
  return async (req, res, url) => {
    const pathname = url.pathname
    if (req.method === 'GET' && pathname === '/api/diagnostics') {
      json(res, 200, diagnostics.report())
    } else if (req.method === 'POST' && pathname === '/api/diagnostics/events') {
      const { events } = clientEventsSchema.parse(await readJson(req))
      for (const event of events) diagnostics.record({ source: 'client', ...event })
      json(res, 200, { recorded: events.length })
    } else if (req.method === 'POST' && pathname === '/api/diagnostics/clear') {
      diagnostics.clear()
      json(res, 200, { cleared: true })
    } else return false
    return true
  }
}
