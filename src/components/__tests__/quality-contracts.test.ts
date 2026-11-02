// @vitest-environment vue-renderer

import { nextTick, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SchemeReview from '../SchemeReview.vue'
import DiagnosticsPanel from '../DiagnosticsPanel.vue'
import { importSchemeJson } from '../../domain/import'
import { reviewScheme, type ReviewFinding } from '../../domain/review-scheme'
import { PROTOTYPE_RULES } from '../../domain/normative-parameters'
import { markState } from '../../domain/review-marks'
import { loadDiagnostics, clearDiagnostics } from '../../services/diagnostics'
import { content, dispatch, nodes, renderComponent, type HostNode } from './test-renderer'
import raw from '../../../tests/fixtures/manual-v1.json?raw'

vi.mock('../../composables/usePu66Status', () => ({ usePu66Status: () => ({ findings: ref([]) }) }))
vi.mock('../../services/diagnostics', () => ({
  appBuild: { version: 'test', commit: 'unknown', builtAt: '' },
  loadDiagnostics: vi.fn(),
  clearDiagnostics: vi.fn(),
}))
const cleanups: Array<() => void> = []
function mount(component: Parameters<typeof renderComponent>[0], props: Record<string, unknown>) {
  const result = renderComponent(component, props, createPinia())
  cleanups.push(result.unmount)
  return result
}
const report = { kind: 'editor-of-tod-diagnostics', events: [], eventsTotal: 0 }
const button = (root: HostNode, label: string) =>
  nodes(root, (node) => node.tag === 'button' && content(node).trim() === label)[0]!
const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await nextTick()
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(loadDiagnostics).mockResolvedValue(report)
  vi.mocked(clearDiagnostics).mockResolvedValue(undefined)
})
afterEach(() => {
  cleanups.splice(0).forEach((unmount) => unmount())
  setActivePinia(undefined)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function review() {
  const scheme = importSchemeJson(raw).scheme
  const apply = vi.fn()
  const navigate = vi.fn()
  const mounted = mount(SchemeReview, {
    scheme,
    hasPendingInput: false,
    onApply: apply,
    onNavigate: navigate,
  })
  const finding = reviewScheme(scheme, PROTOTYPE_RULES).find(
    (f) => f.kind === 'verify' && !f.markBlocked,
  )!
  const row = () => nodes(mounted.root, (node) => node.props['data-check'] === finding.id)[0]!
  const checkbox = () => nodes(row(), (node) => node.tag === 'input')[0]!
  return { ...mounted, scheme, finding, apply, navigate, row, checkbox }
}

describe('real SchemeReview SFC contracts', () => {
  it('emits an immutable marked project, renders accepted props and invalidates a stale mark', async () => {
    const view = review()
    await dispatch(view.checkbox(), 'onChange', { target: { checked: true } })
    expect(view.apply).toHaveBeenCalledTimes(1)
    const changed = view.apply.mock.calls[0]![0]
    expect(markState(changed, view.finding).status).toBe('marked')
    expect(view.scheme.reviewMarks[view.finding.id]).toBeUndefined()
    view.props.scheme = changed
    await nextTick()
    expect(view.checkbox().props.checked).toBe(true)
    expect(content(view.row())).toContain('Отмечено')
    view.props.scheme = {
      ...changed,
      reviewMarks: {
        ...changed.reviewMarks,
        [view.finding.id]: { fingerprint: 'changed', markedAt: '2026-01-01T00:00:00.000Z' },
      },
    }
    await nextTick()
    expect(view.checkbox().props.checked).toBe(false)
    expect(content(view.row())).toContain('проверьте снова')
  })

  it.each(['locked', 'hasPendingInput'])(
    'prevents marking through both disabled UI and event guard: %s',
    async (flag) => {
      const view = review()
      view.props[flag] = true
      await nextTick()
      expect(view.checkbox().props.disabled).toBe(true)
      await dispatch(view.checkbox(), 'onChange', { target: { checked: true } })
      expect(view.apply).not.toHaveBeenCalled()
      if (flag === 'hasPendingInput')
        expect(content(view.root)).toContain('неприменённые изменения')
      view.props[flag] = false
      await nextTick()
      expect(view.checkbox().props.disabled).toBe(false)
      await dispatch(view.checkbox(), 'onChange', { target: { checked: true } })
      expect(view.apply).toHaveBeenCalledTimes(1)
    },
  )

  it('renders blocked reasons and emits the precise navigation finding without changing marks', async () => {
    const view = review()
    const blocked = reviewScheme(view.scheme, PROTOTYPE_RULES).find(
      (f) => f.kind === 'verify' && f.markBlocked,
    )!
    const row = nodes(view.root, (node) => node.props['data-check'] === blocked.id)[0]!
    expect(nodes(row, (node) => node.tag === 'input')[0]!.props.disabled).toBe(true)
    expect(content(row)).toContain(blocked.markBlocked)
    const link = nodes(row, (node) => node.tag === 'a')[0]!
    const preventDefault = vi.fn()
    await dispatch(link, 'onClick', { preventDefault })
    expect(preventDefault).toHaveBeenCalled()
    expect(view.navigate.mock.calls[0]![0] as ReviewFinding).toEqual(blocked)
    expect(view.apply).not.toHaveBeenCalled()
  })
})

describe('real DiagnosticsPanel SFC contracts', () => {
  it('shows an adapter failure and recovers on refresh without clearing the journal', async () => {
    vi.mocked(loadDiagnostics).mockRejectedValueOnce(new Error('Сервер недоступен'))
    const view = mount(DiagnosticsPanel, { scheme: null, view: 'registry' })
    await flush()
    expect(
      nodes(view.root, (node) => node.props.role === 'alert')
        .map(content)
        .join(''),
    ).toContain('Сервер недоступен')
    await dispatch(button(view.root, 'Обновить'), 'onClick')
    await flush()
    expect(nodes(view.root, (node) => node.props.role === 'alert')).toHaveLength(0)
    expect(content(view.root)).toContain('Ошибок и медленных операций в журнале нет')
    expect(clearDiagnostics).not.toHaveBeenCalled()
  })

  it('keeps all actions disabled while clearing and refreshes only after success', async () => {
    let resolve!: () => void
    vi.mocked(clearDiagnostics).mockReturnValue(
      new Promise<void>((done) => {
        resolve = done
      }),
    )
    const view = mount(DiagnosticsPanel, { scheme: null, view: 'registry' })
    await flush()
    const pending = dispatch(button(view.root, 'Очистить журнал'), 'onClick')
    await nextTick()
    expect(
      nodes(view.root, (node) => node.tag === 'button').every((node) => node.props.disabled),
    ).toBe(true)
    expect(loadDiagnostics).toHaveBeenCalledTimes(1)
    resolve()
    await pending
    await nextTick()
    expect(loadDiagnostics).toHaveBeenCalledTimes(2)
    expect(content(view.root)).toContain('Журнал диагностики очищен')
    expect(
      nodes(view.root, (node) => node.tag === 'button').every((node) => !node.props.disabled),
    ).toBe(true)
  })

  it('recovers from clear failure without claiming success or refreshing away the old report', async () => {
    vi.mocked(clearDiagnostics).mockRejectedValueOnce(new Error('Очистка отклонена'))
    const view = mount(DiagnosticsPanel, { scheme: null, view: 'registry' })
    await flush()
    await dispatch(button(view.root, 'Очистить журнал'), 'onClick')
    await nextTick()
    expect(content(view.root)).toContain('Очистка отклонена')
    expect(content(view.root)).not.toContain('Журнал диагностики очищен')
    expect(loadDiagnostics).toHaveBeenCalledTimes(1)
    expect(button(view.root, 'Очистить журнал').props.disabled).toBe(false)
  })

  it('downloads only project shape and releases the blob URL after saving', async () => {
    vi.useFakeTimers()
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const link = { href: '', download: '', click: vi.fn() }
    vi.stubGlobal('document', { createElement: vi.fn(() => link) })
    vi.stubGlobal('navigator', { userAgent: 'test', language: 'ru' })
    vi.stubGlobal('screen', { width: 1200, height: 800 })
    vi.stubGlobal('window', { innerWidth: 1200, innerHeight: 800, devicePixelRatio: 1 })
    const scheme = importSchemeJson(raw).scheme
    scheme.parameters.locationText = 'CONFIDENTIAL-LOCATION'
    scheme.titleBlock.developer.name = 'CONFIDENTIAL-NAME'
    const view = mount(DiagnosticsPanel, { scheme, view: 'registry' })
    await flush()
    await dispatch(button(view.root, 'Скачать диагностику'), 'onClick')
    await nextTick()
    const blob = create.mock.calls[0]![0] as Blob
    const serialized = await blob.text()
    expect(serialized).not.toContain('CONFIDENTIAL')
    expect(serialized).not.toContain(scheme.crossing.referenceId)
    expect(JSON.parse(serialized).interface.project).toMatchObject({
      open: true,
      schemaVersion: 13,
      placements: scheme.placements.length,
    })
    expect(link.click).toHaveBeenCalledTimes(1)
    expect(link.download).toMatch(/^diagnostics_.*\.json$/)
    expect(revoke).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(revoke).toHaveBeenCalledWith('blob:test')
    expect(content(view.root)).toContain('Файл диагностики сохранён')
  })
})
