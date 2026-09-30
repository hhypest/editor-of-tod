import { describe, expect, it } from 'vitest'
import { createUnlinkedScheme } from '../create-scheme'
import { newSignDraft, savePlacement } from '../edit-placements'
import { exportSchemeJson, importSchemeJson } from '../import'
import { clearPinsAfterSignChange, pinSignImages, usedSignCodes } from '../sign-images'
import { drawnSignBase } from '../sheet-drawing'

function example() {
  const scheme = createUnlinkedScheme({
    referenceId: 'TEST-PIN',
    locationText: 'Учебный переезд',
    directionLeft: 'А',
    directionRight: 'Б',
    frontMetres: '18',
    taperMetres: '10',
    bufferMetres: '10',
    speedStagesKmh: ['70', '50', '40'],
    location: 'out',
    approachSpeedKmh: '90',
    yellowTemporarySigns: false,
  })
  const post = newSignDraft()
  if (post.kind !== 'sign-post') throw new Error('Expected sign post')
  post.signCodes = '1.25, 2.6'
  return savePlacement(scheme, post)
}

describe('project sign image pinning', () => {
  it('records per-code revisions and source without saving image bytes', () => {
    const scheme = example()
    const pinned = pinSignImages(scheme, { id: 3, documentCode: 'ГОСТ TEST', edition: '2024' }, [
      { code: '1.25', revision: 2 },
      { code: '2.6', revision: 4 },
    ])
    expect(usedSignCodes(pinned)).toEqual(['1.25', '2.6'])
    expect(pinned.signImages).toEqual({
      catalog: { id: 3, documentCode: 'ГОСТ TEST', edition: '2024' },
      revisions: { '1.25': 2, '2.6': 4 },
    })
    expect(importSchemeJson(exportSchemeJson(pinned)).scheme).toEqual(pinned)
    expect(JSON.stringify(pinned)).not.toContain('PNG')
    expect(scheme.signImages.revisions).toEqual({})
  })

  it('rejects a missing code and never silently pins an incomplete catalog', () => {
    expect(() =>
      pinSignImages(example(), { id: 1, documentCode: 'TEST', edition: '2024' }, [
        { code: '1.25', revision: 1 },
      ]),
    ).toThrow('2.6')
  })

  it('pins the image shown on the sheet and skips signs drawn without PNG', () => {
    const base = example()
    const scheme = {
      ...base,
      placements: base.placements.map((placement) =>
        placement.kind === 'sign-post'
          ? { ...placement, signIds: ['3.24_50', '3.24_40', '8.1.1_150', '1.25'] }
          : placement,
      ),
    }
    const pinned = pinSignImages(scheme, { id: 2, documentCode: 'TEST', edition: '2024' }, [
      { code: '3.24', revision: 5 },
      { code: '1.25', revision: 1 },
    ])
    expect(pinned.signImages.revisions).toEqual({ '3.24': 5, '1.25': 1 })
  })

  it('pins the standard image under a drawn speed sign or distance plate', () => {
    const base = example()
    const scheme = {
      ...base,
      placements: base.placements.map((placement) =>
        placement.kind === 'sign-post'
          ? { ...placement, signIds: ['3.24_70_ж', '8.1.1_150', '1.25'] }
          : placement,
      ),
    }
    const pinned = pinSignImages(scheme, { id: 2, documentCode: 'TEST', edition: '2024' }, [
      { code: '3.24_ж', revision: 3 },
      { code: '8.1.1', revision: 2 },
      { code: '1.25', revision: 1 },
    ])
    expect(pinned.signImages.revisions).toEqual({ '3.24_ж': 3, '8.1.1': 2, '1.25': 1 })
    expect(drawnSignBase('3.24_70_ж')).toBe('3.24_ж')
    expect(drawnSignBase('3.24_40')).toBe('3.24')
    expect(drawnSignBase('8.1.1_150')).toBe('8.1.1')
    expect(drawnSignBase('1.25')).toBeNull()
  })

  it('clears pinned revisions when the used set changes, preserving other edits', () => {
    const scheme = example()
    const pinned = pinSignImages(scheme, { id: 3, documentCode: 'TEST', edition: '2024' }, [
      { code: '1.25', revision: 2 },
      { code: '2.6', revision: 4 },
    ])
    const edited = { ...pinned, placements: pinned.placements.slice(1) }
    const cleared = clearPinsAfterSignChange(pinned, edited)
    expect(cleared.placements).toEqual([])
    expect(cleared.signImages).toEqual({ catalog: null, revisions: {} })
    expect(
      clearPinsAfterSignChange(pinned, { ...pinned, createdAt: '2026-09-28T00:00:00Z' }).signImages,
    ).toEqual(pinned.signImages)
  })
})
