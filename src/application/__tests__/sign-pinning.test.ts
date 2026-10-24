import { describe, expect, it, vi } from 'vitest'
import raw from '../../../tests/fixtures/manual-v1.json?raw'
import { importSchemeJson } from '../../domain/import'
import type { Scheme } from '../../domain/model'
import { PinProjectSigns, type SignCatalogSnapshot } from '../sign-pinning'

const catalog = { id: 1, documentCode: 'Учебный ГОСТ', edition: '2030' }
function scheme(): Scheme {
  const value = importSchemeJson(raw).scheme
  const post = value.placements.find((item) => item.kind === 'sign-post')!
  return { ...value, placements: [{ ...post, signIds: ['1.25'] }] }
}

describe('pinning through a framework-independent catalog port', () => {
  it('returns a pinned snapshot without modifying the open document', async () => {
    const current = scheme()
    const before = JSON.stringify(current)
    const repository = {
      loadCatalog: vi.fn(async () => ({ catalog, signs: [{ code: '1.25', revision: 3 }] })),
    }
    const pinned = await PinProjectSigns(current, repository, () => current)
    expect(pinned.signImages).toEqual({ catalog, revisions: { '1.25': 3 } })
    expect(JSON.stringify(current)).toBe(before)
    expect(repository.loadCatalog).toHaveBeenCalledTimes(1)
  })

  it.each([null, { ...catalog, edition: 'не указана' }])(
    'rejects an unversioned catalog %s',
    async (unversioned) => {
      const current = scheme()
      await expect(
        PinProjectSigns(
          current,
          {
            loadCatalog: async () => ({ catalog: unversioned, signs: [] }),
          },
          () => current,
        ),
      ).rejects.toThrow('Укажите версию ГОСТ при импорте каталога знаков.')
    },
  )

  it.each(['edited', 'closed'])(
    'rejects a late catalog after the document was %s',
    async (kind) => {
      const original = scheme()
      let current: Scheme | null = original
      let resolve!: (value: SignCatalogSnapshot) => void
      const request = new Promise<SignCatalogSnapshot>((yes) => {
        resolve = yes
      })
      const result = PinProjectSigns(original, { loadCatalog: () => request }, () => current)
      current = kind === 'closed' ? null : { ...original, titleBlock: { ...original.titleBlock } }
      resolve({ catalog, signs: [{ code: '1.25', revision: 3 }] })
      await expect(result).rejects.toThrow('Проект изменился; повторите закрепление.')
    },
  )

  it('propagates a catalog read failure without retrying or changing the scheme', async () => {
    const current = scheme()
    const failure = new Error('Учебный сбой')
    const repository = {
      loadCatalog: vi.fn(async () => {
        throw failure
      }),
    }
    await expect(PinProjectSigns(current, repository, () => current)).rejects.toBe(failure)
    expect(repository.loadCatalog).toHaveBeenCalledTimes(1)
    expect(current.signImages.catalog).toBeNull()
  })
})
