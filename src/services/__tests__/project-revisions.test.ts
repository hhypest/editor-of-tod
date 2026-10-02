import { afterEach, describe, expect, it, vi } from 'vitest'
import { importSchemeJson } from '../../domain/import'
import raw from '../../../tests/fixtures/manual-v1.json?raw'
import { saveLocalProject, restoreLocalRevision } from '../local-projects'

const scheme = importSchemeJson(raw).scheme
const saved = { scheme, revision: 4, updatedAt: '2026-10-02T10:00:00.000Z' }
afterEach(() => vi.unstubAllGlobals())

describe('revision HTTP adapter', () => {
  it('sends expected revision in the existing save and restore requests', async () => {
    const fetcher = vi.fn(async () => Response.json(saved))
    vi.stubGlobal('fetch', fetcher)
    expect(await saveLocalProject(scheme, 3)).toEqual(saved)
    expect(await restoreLocalRevision(scheme.id, 1, 3)).toEqual(saved)
    expect(fetcher.mock.calls).toEqual([
      [
        `/api/projects/${scheme.id}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scheme, expectedRevision: 3 }),
        },
      ],
      [
        `/api/projects/${scheme.id}/restore`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourceRevision: 1, expectedRevision: 3 }),
        },
      ],
    ])
  })

  it.each([saveLocalProject, () => restoreLocalRevision(scheme.id, 1, 3)])(
    'maps conflicts without retrying the write',
    async (write) => {
      const fetcher = vi.fn(async () =>
        Response.json({ error: 'Запись изменилась в другом окне.' }, { status: 409 }),
      )
      vi.stubGlobal('fetch', fetcher)
      await expect(write(scheme, 3)).rejects.toMatchObject({
        name: 'ProjectRevisionError',
        code: 'conflict',
      })
      expect(fetcher).toHaveBeenCalledTimes(1)
    },
  )

  it('classifies unavailable, failed and invalid responses', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    fetcher.mockRejectedValueOnce(new TypeError('network'))
    await expect(saveLocalProject(scheme, 3)).rejects.toMatchObject({ code: 'unavailable' })
    fetcher.mockResolvedValueOnce(Response.json({ error: 'Ошибка записи' }, { status: 500 }))
    await expect(saveLocalProject(scheme, 3)).rejects.toMatchObject({ code: 'failed' })
    for (const response of [
      Response.json({ revision: 4 }),
      new Response('<html>proxy</html>', { status: 502 }),
      new Response('{', { headers: { 'Content-Type': 'application/json' } }),
    ]) {
      fetcher.mockResolvedValueOnce(response)
      await expect(saveLocalProject(scheme, 3)).rejects.toMatchObject({ code: 'invalid-response' })
    }
  })
})
