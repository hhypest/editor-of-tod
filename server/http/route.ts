import type { IncomingMessage, ServerResponse } from 'node:http'

/** False leaves the request untouched for the next group; errors reach the shared mapper. */
export type RouteHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>
