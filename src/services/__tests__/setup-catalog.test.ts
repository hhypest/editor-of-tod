import { afterEach, describe, expect, it, vi } from 'vitest'
import { diagnosticError } from '../../shared/diagnostic-data'
import { loadSetupStatus } from '../setup-status'
import { getSignCatalogSource, listSigns, loadSignCatalogSnapshot } from '../local-signs'

afterEach(() => vi.unstubAllGlobals())

function respond(data: Record<string, unknown>) {
  const fetcher = vi.fn(async (url: string) => Response.json(data[url]))
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}

describe('setup and sign HTTP boundaries', () => {
  it('reads the edition reference for the sheet without imposing the import metadata contract', async () => {
    const catalog = { id: 2, documentCode: 'УЧЕБНЫЙ', edition: '2026' }
    respond({ '/api/signs/catalog': catalog })
    expect(await getSignCatalogSource()).toEqual(catalog)
  })
  it('reads all three existing setup lists without inferring normative readiness', async () => {
    const fetcher = respond({ '/api/pu66': [{}], '/api/signs': [{}, {}], '/api/projects': [] })
    expect(await loadSetupStatus()).toEqual({ cards: 1, signs: 2, projects: 0 })
    expect(fetcher.mock.calls.map(([url]) => url).sort()).toEqual([
      '/api/projects',
      '/api/pu66',
      '/api/signs',
    ])
  })

  it('rejects a malformed setup list instead of reporting a ready step', async () => {
    respond({ '/api/pu66': [], '/api/signs': { length: 1 }, '/api/projects': [] })
    await expect(loadSetupStatus()).rejects.toMatchObject({ code: 'invalid-response' })
  })

  it('reads the pinning snapshot without requiring unused catalog or image metadata', async () => {
    const catalog = { id: 7, documentCode: 'Учебный ГОСТ', edition: '2030' }
    respond({ '/api/signs': [{ code: '1.25', revision: 2 }], '/api/signs/catalog': catalog })
    expect(await loadSignCatalogSnapshot()).toEqual({
      catalog,
      signs: [{ code: '1.25', revision: 2 }],
    })
  })

  it('allows an absent catalog so the session can keep its existing explanatory message', async () => {
    respond({ '/api/signs': [], '/api/signs/catalog': null })
    expect(await loadSignCatalogSnapshot()).toEqual({ signs: [], catalog: null })
  })

  it.each([0, -1, 1.5, '2', undefined])('rejects invalid pin revision %s', async (revision) => {
    respond({ '/api/signs': [{ code: '1.25', revision }], '/api/signs/catalog': null })
    await expect(loadSignCatalogSnapshot()).rejects.toMatchObject({ code: 'invalid-response' })
  })

  it('requires usable image dimensions at the display boundary', async () => {
    respond({ '/api/signs': [{ code: '1.25', revision: 2, width: 0, height: 40 }] })
    await expect(listSigns()).rejects.toMatchObject({ code: 'invalid-response' })
  })

  it('classifies a failed connection without leaking its text into diagnostics', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('private/card.xlsx')))
    const error = await loadSetupStatus().catch((cause: unknown) => cause)
    expect(error).toMatchObject({ code: 'database-unavailable' })
    expect(JSON.stringify(diagnosticError(error))).not.toContain('private/card.xlsx')
  })

  it('hides proxy HTML and raw parse errors behind a coded response failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>private</html>')),
    )
    await expect(loadSetupStatus()).rejects.toMatchObject({ code: 'invalid-response' })
  })
})
