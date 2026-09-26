import { describe, expect, it } from 'vitest'
import fixture from '../../../tests/fixtures/legacy-b34-manual.json?raw'
import {
  createPlacementDraft,
  newSignDraft,
  newTextDraft,
  PlacementEditError,
  removePlacement,
  savePlacement,
} from '../edit-placements'
import { exportSchemeJson, importSchemeJson } from '../import'

const original = importSchemeJson(fixture, {
  id: '55740b36-080a-4cbe-9476-e71ffb1ab47f',
  now: '2026-09-26T12:00:00.000Z',
}).scheme

describe('editing saved placements', () => {
  it('edits a generated sign post as a manual object without moving others', () => {
    const placement = original.placements[0]!
    const draft = createPlacementDraft(placement)
    expect(draft.kind).toBe('sign-post')
    if (draft.kind !== 'sign-post') throw new Error('Expected sign post')
    draft.x = '-25,5'
    draft.signCodes = '3.24_40_ж, 1.25'
    const updated = savePlacement(original, draft)

    expect(updated.placements[0]).toMatchObject({
      id: placement.id,
      generatedByTemplate: false,
      signIds: ['3.24_40_ж', '1.25'],
      position: { anchor: placement.position.anchor, offsetXSvg: -25.5 },
    })
    expect(updated.placements.slice(1)).toEqual(original.placements.slice(1))
    expect(updated.nextPlacementId).toBe(original.nextPlacementId)
    expect(updated.source).toMatchObject({ originalJson: fixture })
    expect(original.placements[0]).toEqual(placement)
    expect(importSchemeJson(exportSchemeJson(updated)).scheme).toEqual(updated)
  })

  it('adds a sign post and text with unique IDs, then removes one without reusing it', () => {
    const sign = newSignDraft()
    if (sign.kind !== 'sign-post') throw new Error('Expected sign post')
    sign.signCodes = '9.99'
    sign.x = '820'
    const withSign = savePlacement(original, sign)
    expect(withSign.placements.at(-1)).toMatchObject({
      kind: 'sign-post',
      id: 12,
      generatedByTemplate: false,
      signIds: ['9.99'],
    })
    expect(withSign.nextPlacementId).toBe(13)

    const text = newTextDraft()
    if (text.kind !== 'element') throw new Error('Expected text')
    text.text = 'Проверочная надпись'
    const withText = savePlacement(withSign, text)
    expect(withText.placements.at(-1)).toMatchObject({
      id: 13,
      kind: 'element',
      elementKind: 'text',
      text: 'Проверочная надпись',
    })
    const removed = removePlacement(withText, 12)
    expect(removed.placements.some((item) => item.id === 12)).toBe(false)
    expect(removed.nextPlacementId).toBe(14)
    expect(importSchemeJson(exportSchemeJson(removed)).scheme).toEqual(removed)
  })

  it('edits a non-text element without changing its type or dimensions', () => {
    const cone = original.placements.find((item) => item.id === 11)!
    if (cone.kind !== 'element') throw new Error('Expected cone element')
    const draft = createPlacementDraft(cone)
    if (draft.kind !== 'element') throw new Error('Expected element')
    draft.x = '42,5'
    const updated = savePlacement(original, draft)
    expect(updated.placements.find((item) => item.id === 11)).toMatchObject({
      kind: 'element',
      elementKind: 'cone',
      generatedByTemplate: false,
      position: { offsetXSvg: 42.5 },
      sizeSvg: cone.sizeSvg,
    })
    expect(updated.placements.filter((item) => item.id !== 11)).toEqual(
      original.placements.filter((item) => item.id !== 11),
    )
  })

  it('rejects invalid numbers and empty sign/text entries without changing the project', () => {
    const sign = newSignDraft()
    expect(() => savePlacement(original, sign)).toThrow(PlacementEditError)
    if (sign.kind !== 'sign-post') throw new Error('Expected sign post')
    sign.signCodes = '1.25'
    sign.x = 'не число'
    expect(() => savePlacement(original, sign)).toThrow('Поле «X»')

    const text = newTextDraft()
    expect(() => savePlacement(original, text)).toThrow('не может быть пустой')
    if (text.kind !== 'element') throw new Error('Expected text')
    text.text = 'Проба'
    text.fontSize = '0'
    expect(() => savePlacement(original, text)).toThrow('Размер шрифта')
    expect(() => removePlacement(original, 999)).toThrow('не найден')
    expect(original.placements).toHaveLength(4)
  })
})
