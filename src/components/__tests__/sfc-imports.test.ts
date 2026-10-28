// @vitest-environment vue-renderer

import { setActivePinia } from 'pinia'
import { afterEach, expect, it, vi } from 'vitest'

const modules = import.meta.glob<{ default: { setup?: unknown; render?: unknown } }>(
  '../../**/*.vue',
)
afterEach(() => vi.unstubAllGlobals())

it('imports every real client SFC without starting an app, Pinia session or network request', async () => {
  setActivePinia(undefined)
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('SFC import started a request')
    }),
  )
  expect(Object.keys(modules).length).toBeGreaterThan(0)
  for (const [path, load] of Object.entries(modules)) {
    const component = (await load()).default
    expect(
      typeof component.setup === 'function' || typeof component.render === 'function',
      path,
    ).toBe(true)
  }
  expect(fetch).not.toHaveBeenCalled()
})
