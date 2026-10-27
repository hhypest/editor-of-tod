import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useNormativeRules } from '../useNormativeRules'
import { PROTOTYPE_RULES, type ParameterState } from '../../domain/normative-parameters'

const api = vi.hoisted(() => ({ list: vi.fn<() => Promise<ParameterState[]>>() }))
vi.mock('../../services/local-normatives', () => ({ listParameterStates: api.list }))

beforeEach(() => {
  api.list.mockReset()
  setActivePinia(createPinia())
})
afterEach(() => setActivePinia(undefined))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

// Synthetic decision data; no text or values extracted from normative documents.
function confirmedState(value: number): ParameterState {
  return {
    id: 'project-front-limit',
    status: { kind: 'confirmed' },
    document: null,
    quote: null,
    suggestion: null,
    amendments: [],
    confirmation: {
      id: 1,
      parameterId: 'project-front-limit',
      documentId: null,
      documentLabel: '',
      clause: '',
      page: null,
      quote: '',
      fragment: '',
      value,
      confirmedBy: 'Учебный составитель',
      confirmedAt: '2030-01-01',
      note: 'Вымышленное решение для проверки состояния интерфейса',
    },
  }
}

describe('shared normative state across the Pinia migration (#191)', () => {
  it('starts with prototype rules and does not fetch just because another consumer reads it', () => {
    const first = useNormativeRules()
    const second = useNormativeRules()
    expect(first.states.value).toEqual([])
    expect(first.rules.value).toEqual(PROTOTYPE_RULES)
    expect(first.loading.value).toBe(false)
    expect(first.error.value).toBe('')
    expect(second.states.value).toEqual([])
    expect(second.rules.value).toEqual(PROTOTYPE_RULES)
    expect(second.loading.value).toBe(false)
    expect(second.error.value).toBe('')
    expect(api.list).not.toHaveBeenCalled()
  })

  it('shares one in-flight reload and publishes the response to all consumers', async () => {
    const response = deferred<ParameterState[]>()
    api.list.mockReturnValueOnce(response.promise)
    const first = useNormativeRules()
    const second = useNormativeRules()
    const firstReload = first.reload()
    const secondReload = second.reload()
    expect(api.list).toHaveBeenCalledTimes(1)
    expect(first.loading.value).toBe(true)
    expect(second.loading.value).toBe(true)
    const state = confirmedState(42)
    response.resolve([state])
    await Promise.all([firstReload, secondReload])
    expect(first.states.value).toEqual([state])
    expect(second.rules.value.frontLimitMetres).toBe(42)
    expect(second.rules.value.confirmed['project-front-limit']).toBe(true)
    expect(second.loading.value).toBe(false)
  })

  it('retains the previous response and exposes a shared error after a failed reload', async () => {
    const first = useNormativeRules()
    const second = useNormativeRules()
    api.list.mockResolvedValueOnce([confirmedState(42)])
    await first.reload()
    const previousRules = first.rules.value
    api.list.mockRejectedValueOnce(new Error('Учебный отказ чтения'))
    await second.reload()
    expect(first.error.value).toBe('Учебный отказ чтения')
    expect(second.error.value).toBe('Учебный отказ чтения')
    expect(first.rules.value).toEqual(previousRules)
    expect(first.states.value).toEqual([confirmedState(42)])
    expect(first.loading.value).toBe(false)
  })

  it('allows retry after failure and clears the error only after a successful response', async () => {
    const state = useNormativeRules()
    api.list.mockRejectedValueOnce(new Error('Учебный отказ'))
    await state.reload()
    const response = deferred<ParameterState[]>()
    api.list.mockReturnValueOnce(response.promise)
    const retry = state.reload()
    expect(state.error.value).toBe('Учебный отказ')
    expect(state.loading.value).toBe(true)
    response.resolve([confirmedState(43)])
    await retry
    expect(api.list).toHaveBeenCalledTimes(2)
    expect(state.error.value).toBe('')
    expect(state.loading.value).toBe(false)
    expect(state.rules.value.frontLimitMetres).toBe(43)
  })

  it('uses the fallback message for a non-Error rejection and settles all waiting callers', async () => {
    const response = deferred<ParameterState[]>()
    api.list.mockReturnValueOnce(response.promise)
    const state = useNormativeRules()
    const pending = [state.reload(), useNormativeRules().reload()]
    response.reject('synthetic failure')
    await Promise.all(pending)
    expect(api.list).toHaveBeenCalledTimes(1)
    expect(state.error.value).toBe('Нормативные параметры недоступны.')
    expect(state.loading.value).toBe(false)
    expect(state.rules.value).toEqual(PROTOTYPE_RULES)
  })

  it('replaces the previous list on a later reload, including an empty successful response', async () => {
    const state = useNormativeRules()
    api.list.mockResolvedValueOnce([confirmedState(42)]).mockResolvedValueOnce([])
    await state.reload()
    expect(state.rules.value.confirmed['project-front-limit']).toBe(true)
    await state.reload()
    expect(api.list).toHaveBeenCalledTimes(2)
    expect(state.states.value).toEqual([])
    expect(state.rules.value).toEqual(PROTOTYPE_RULES)
    expect(state.error.value).toBe('')
  })
})

describe('normative state ownership (#191)', () => {
  it('isolates data, errors and pending requests between apps even when the active Pinia changes', async () => {
    const firstApp = createApp({ render: () => null }).use(createPinia())
    const secondApp = createApp({ render: () => null }).use(createPinia())
    const first = firstApp.runWithContext(() => useNormativeRules())
    const second = secondApp.runWithContext(() => useNormativeRules())
    const firstResponse = deferred<ParameterState[]>()
    const secondResponse = deferred<ParameterState[]>()
    api.list.mockReturnValueOnce(firstResponse.promise).mockReturnValueOnce(secondResponse.promise)
    const firstReload = first.reload()
    const secondReload = second.reload()
    expect(api.list).toHaveBeenCalledTimes(2)
    firstResponse.resolve([confirmedState(42)])
    await firstReload
    expect(first.rules.value.frontLimitMetres).toBe(42)
    expect(second.states.value).toEqual([])
    expect(second.loading.value).toBe(true)
    expect(second.rules.value).toEqual(PROTOTYPE_RULES)
    secondResponse.reject(new Error('Учебный отказ второго окна'))
    await secondReload
    expect(second.error.value).toBe('Учебный отказ второго окна')
    expect(first.error.value).toBe('')
    expect(first.states.value).toEqual([confirmedState(42)])
    // Re-enter the first app after actions in the second: injection must select its own store.
    const anotherFirstConsumer = firstApp.runWithContext(() => useNormativeRules())
    expect(anotherFirstConsumer.rules.value.frontLimitMetres).toBe(42)
    expect(anotherFirstConsumer.error.value).toBe('')
  })

  it('shares one request for two consumers in the same app without changing the public facade', async () => {
    const app = createApp({ render: () => null }).use(createPinia())
    const first = app.runWithContext(() => useNormativeRules())
    const second = app.runWithContext(() => useNormativeRules())
    expect(Object.keys(first).sort()).toEqual(['error', 'loading', 'reload', 'rules', 'states'])
    const response = deferred<ParameterState[]>()
    api.list.mockReturnValueOnce(response.promise)
    const pending = [first.reload(), second.reload()]
    expect(api.list).toHaveBeenCalledTimes(1)
    expect(second.loading.value).toBe(true)
    response.resolve([confirmedState(43)])
    await Promise.all(pending)
    expect(first.rules.value.frontLimitMetres).toBe(43)
    expect(second.states.value).toEqual([confirmedState(43)])
    expect(first.loading.value).toBe(false)
    expect(second.loading.value).toBe(false)
  })
})
