import { describe, expect, it } from 'vitest'
import fixture from '../../../tests/fixtures/manual-v1.json?raw'
import { recordEdit, redoEdit, startHistory, undoEdit } from '../edit-history'
import { newTextDraft, removePlacement, savePlacement } from '../edit-placements'
import { exportSchemeJson, importSchemeJson } from '../import'

describe('undo and redo of applied project changes', () => {
  it('restores the exact prior snapshot and clears redo after a new edit', () => {
    const original = importSchemeJson(fixture, {
      id: '55740b36-080a-4cbe-9476-e71ffb1ab47f',
      now: '2026-09-26T12:00:00.000Z',
    }).scheme
    const text = newTextDraft()
    if (text.kind !== 'element') throw new Error('Expected text')
    text.text = 'Пробная надпись'
    const edited = savePlacement(original, text)
    const removed = removePlacement(edited, 1)
    const history = recordEdit(recordEdit(startHistory(original), edited), removed)
    const oneBack = undoEdit(history)
    expect(oneBack.present).toBe(edited)
    expect(undoEdit(oneBack).present).toBe(original)
    expect(redoEdit(oneBack).present).toBe(removed)
    expect(recordEdit(oneBack, removePlacement(edited, 2)).future).toEqual([])
    expect(importSchemeJson(exportSchemeJson(oneBack.present)).scheme).toEqual(edited)
    expect(oneBack.present.source.originalJson).toBe(fixture)
    expect(history.present).toBe(removed)
  })

  it('keeps only the latest 30 undo steps', () => {
    let history = startHistory(0)
    for (let value = 1; value <= 35; value++) history = recordEdit(history, value)
    expect(history.past).toHaveLength(30)
    expect(history.past[0]).toBe(5)
    expect(undoEdit(startHistory(0))).toEqual(startHistory(0))
  })
})
