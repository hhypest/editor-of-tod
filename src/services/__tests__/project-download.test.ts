import { afterEach, expect, it, vi } from 'vitest'
import raw from '../../../tests/fixtures/manual-v1.json?raw'
import { importSchemeJson } from '../../domain/import'
import { downloadProjectJson } from '../project-download'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('downloads the exact supplied JSON under a safe local name and releases the Blob URL later', async () => {
  vi.useFakeTimers()
  const scheme = importSchemeJson(raw).scheme
  scheme.crossing.referenceId = 'Учебный/переезд'
  const before = JSON.stringify(scheme)
  const content = '{"учебный":"снимок"}'
  let blob!: Blob
  const createObjectURL = vi.fn((value: Blob) => {
    blob = value
    return 'blob:synthetic'
  })
  const revokeObjectURL = vi.fn()
  const link = { href: '', download: '', click: vi.fn(), remove: vi.fn() }
  const append = vi.fn()
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
  vi.stubGlobal('window', { setTimeout })
  vi.stubGlobal('document', { body: { append }, createElement: vi.fn(() => link) })
  downloadProjectJson(scheme, content, 'v10')
  expect(link.href).toBe('blob:synthetic')
  expect(link.download).toBe('scheme_Учебный_переезд_v10.json')
  expect(await blob.text()).toBe(content)
  expect(append).toHaveBeenCalledWith(link)
  expect(link.click).toHaveBeenCalledTimes(1)
  expect(link.remove).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(scheme)).toBe(before)
  await vi.advanceTimersByTimeAsync(999)
  expect(revokeObjectURL).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:synthetic')
})
