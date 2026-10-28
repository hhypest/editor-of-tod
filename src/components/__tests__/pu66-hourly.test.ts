// @vitest-environment vue-renderer
import { nextTick, ref } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Pu66NormsPanel from '../Pu66NormsPanel.vue'
import { PROTOTYPE_RULES } from '../../domain/normative-parameters'
import type { Pu66Norms } from '../../domain/pu66-norms'
import { getPu66Norms } from '../../services/local-normatives'
import { content, dispatch, nodes, renderComponent } from './test-renderer'

const rules = ref({
  ...PROTOTYPE_RULES,
  peakHourShare: 0.2,
  confirmed: { ...PROTOTYPE_RULES.confirmed, 'peak-hour-share': true },
})
vi.mock('../../composables/useNormativeRules', () => ({ useNormativeRules: () => ({ rules }) }))
vi.mock('../../services/local-normatives', () => ({ getPu66Norms: vi.fn() }))
const cleanups: Array<() => void> = []
const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await nextTick()
}
function card(referenceId = 'DEMO-A', revision = 2): Pu66Norms {
  return {
    referenceId,
    revision,
    updatedAt: '2030-02-01T00:00:00.000Z',
    carCountPerDay: 600,
    trainCountPerDay: null,
    roadCategory: 'II',
    trainVisibilityMetres: { rightOdd: null, rightEven: null, leftOdd: null, leftEven: null },
    years: { previous: '', current: '' },
    technicalRows: [],
  }
}
function mount() {
  const onHourly = vi.fn()
  const view = renderComponent(Pu66NormsPanel, {
    referenceId: 'DEMO-A',
    pinnedRevision: 1,
    location: 'out',
    onHourly,
  })
  cleanups.push(view.unmount)
  return { ...view, onHourly }
}
beforeEach(() => {
  vi.clearAllMocks()
  rules.value.confirmed['peak-hour-share'] = true
  vi.mocked(getPu66Norms).mockResolvedValue(card())
})
afterEach(() => cleanups.splice(0).forEach((fn) => fn()))

it('requires the exact pinned card revision before using hourly traffic; programmatic clicks are guarded', async () => {
  const view = mount()
  await flush()
  let button = nodes(
    view.root,
    (node) => node.tag === 'button' && content(node).includes('Подставить'),
  )[0]!
  expect(button.props.disabled).toBe(true)
  await dispatch(button, 'onClick')
  expect(view.onHourly).not.toHaveBeenCalled()
  view.props.pinnedRevision = 2
  await flush()
  await flush()
  button = nodes(
    view.root,
    (node) => node.tag === 'button' && content(node).includes('Подставить'),
  )[0]!
  expect(button.props.disabled).toBe(false)
  await dispatch(button, 'onClick')
  expect(view.onHourly).toHaveBeenCalledExactlyOnceWith('120')
  view.props.locked = true
  await flush()
  await dispatch(button, 'onClick')
  expect(view.onHourly).toHaveBeenCalledTimes(1)
})

it('does not replace a newly selected card with a late response and never supplies a default coefficient', async () => {
  let resolveOld!: (value: Pu66Norms) => void
  vi.mocked(getPu66Norms).mockReturnValueOnce(
    new Promise((resolve) => {
      resolveOld = resolve
    }),
  )
  const view = mount()
  view.props.referenceId = 'DEMO-B'
  view.props.pinnedRevision = 2
  vi.mocked(getPu66Norms).mockResolvedValue(card('DEMO-B'))
  await flush()
  await flush()
  resolveOld({ ...card('DEMO-A'), carCountPerDay: 9999 })
  await flush()
  expect(content(view.root)).not.toContain('9999')
  const button = nodes(
    view.root,
    (node) => node.tag === 'button' && content(node).includes('Подставить'),
  )[0]!
  await dispatch(button, 'onClick')
  expect(view.onHourly).toHaveBeenCalledExactlyOnceWith('120')
  rules.value.confirmed['peak-hour-share'] = false
  await flush()
  expect(
    nodes(view.root, (node) => node.tag === 'button' && content(node).includes('Подставить')),
  ).toEqual([])
  expect(content(view.root)).toContain('подтвердите долю часа пик')
})
