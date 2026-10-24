import { test as base } from '@playwright/test'
export { expect, type Page, type APIRequestContext } from '@playwright/test'
/** Existing-workspace scenarios start after the user chose to defer first-run setup.
 * The undismissed clean start and its complete flow are covered in first-run.spec.ts. */
export const test = base.extend({
  context: async ({ context }, use) => {
    await context.addInitScript(() => sessionStorage.setItem('tod.setup.deferred', '1'))
    await use(context)
  },
})
