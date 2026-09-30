import { describe, expect, it } from 'vitest'
import { anchorSchema } from '../model'
import {
  anchorLabels,
  elementLabels,
  placementTitle,
  sideLabels,
  standLabels,
} from '../placement-labels'
import { templateLabel } from '../registry'

describe('Russian labels for object properties', () => {
  it('covers every stored code with a Cyrillic label', () => {
    expect(Object.keys(anchorLabels).sort()).toEqual([...anchorSchema.options].sort())
    for (const label of [
      ...Object.values(anchorLabels),
      ...Object.values(sideLabels),
      ...Object.values(standLabels),
      ...Object.values(elementLabels),
    ]) {
      expect(label).toMatch(/[А-Яа-яЁё]/)
      expect(label).not.toMatch(/^(up|down|left|right|abs|car|cone|complex|pit|reg|text)$/)
    }
  })

  it('names objects in lists without internal kinds', () => {
    const base = { id: 1, generatedByTemplate: false } as const
    expect(
      placementTitle({
        ...base,
        kind: 'element',
        elementKind: 'car',
        position: { anchor: 'L1', offsetXSvg: 0, ySvg: 0 },
        sizeSvg: { width: 1, height: 1 },
        text: null,
        fontSizeSvg: null,
        bold: false,
      }),
    ).toBe('Автомобиль прикрытия')
  })

  it('writes figure names with Cyrillic Б and a dot', () => {
    expect(templateLabel('b33')).toBe('Б.33')
    expect(templateLabel('b34')).toBe('Б.34')
  })
})
