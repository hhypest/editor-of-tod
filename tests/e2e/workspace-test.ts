import { test as base } from './browser-test'
export { expect, type Page, type APIRequestContext } from './browser-test'
/** Existing-workspace scenarios start after the user chose to defer first-run setup.
 * The undismissed clean start and its complete flow are covered in first-run.spec.ts. */
export const test = base.extend({
  context: async ({ context }, use) => {
    await context.addInitScript(() => {
      // Playwright also evaluates init scripts in the initial opaque about:blank document.
      // That document has no usable sessionStorage; the real local page is seeded on navigation.
      if (location.protocol === 'http:' || location.protocol === 'https:')
        sessionStorage.setItem('tod.setup.deferred', '1')
    })
    await use(context)
  },
})
