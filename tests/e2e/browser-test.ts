import { test as base } from '@playwright/test'
export { expect, type Page, type APIRequestContext } from '@playwright/test'

/** Diagnose transport/browser failures without replacing assertions, timeouts or CI retries. */
export const test = base.extend({
  context: async ({ context }, use, testInfo) => {
    const failures: Array<{ at: string; method: string; path: string; error: string }> = []
    context.on('requestfailed', (request) => {
      const url = new URL(request.url())
      failures.push({
        at: new Date().toISOString(),
        method: request.method(),
        path: url.pathname,
        error: request.failure()?.errorText ?? 'unknown',
      })
    })
    await use(context)
    if (testInfo.status !== testInfo.expectedStatus)
      await testInfo.attach('browser-transport', {
        body: JSON.stringify({ browser: testInfo.project.name, failures }, null, 2),
        contentType: 'application/json',
      })
  },
})
