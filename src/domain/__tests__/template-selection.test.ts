import { describe, expect, it } from 'vitest'
import { selectTemplateByWorkFront } from '../registry'

describe('work front length selection policy', () => {
  it('uses B.34 below 30 m and B.33 at 30 m and above', () => {
    expect(selectTemplateByWorkFront(29.99)).toEqual({ code: 'b34', boundaryNeedsReview: false })
    expect(selectTemplateByWorkFront(30)).toEqual({ code: 'b33', boundaryNeedsReview: true })
    expect(selectTemplateByWorkFront(30.01)).toEqual({ code: 'b33', boundaryNeedsReview: false })
  })

  it('rejects missing and non-finite lengths', () => {
    for (const value of [0, -1, NaN, Infinity]) {
      expect(() => selectTemplateByWorkFront(value)).toThrow(RangeError)
    }
  })
})
