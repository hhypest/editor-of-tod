import { createServerServices } from '../composition-root'
import { composeServerRuntime } from '../server-runtime'

/** Real owners on one initialized connection, with the production HTTP/CLI composition.
 * No domain forwarding methods: tests address the owner whose contract they exercise.
 */
export function openTestApplication(
  path: string,
  now: () => string = () => new Date().toISOString(),
) {
  const clock = () => now()
  const services = createServerServices(path, clock)
  return { ...services, runtime: composeServerRuntime(path, services, clock) }
}

export type TestApplication = ReturnType<typeof openTestApplication>
