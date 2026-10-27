import { ref, shallowRef } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia, storeToRefs } from 'pinia'
import { useProjectSessionUiStore } from '../../stores/project-session-ui'
import raw from '../../../tests/fixtures/manual-v1.json?raw'
import { importSchemeJson } from '../../domain/import'
import { PROTOTYPE_RULES } from '../../domain/normative-parameters'
import { useTemplateActions } from '../useTemplateActions'

vi.mock('../../services/diagnostics', () => ({ reportError: vi.fn() }))
beforeEach(() => setActivePinia(createPinia()))
afterEach(() => setActivePinia(undefined))

describe('catalog delivery to the template UI adapter', () => {
  it('delivers pin feedback to explicit owner refs after active Pinia changes', async () => {
    const state = storeToRefs(useProjectSessionUiStore())
    const imported = shallowRef(importSchemeJson(raw))
    const onProjectApplied = vi.fn()
    const actions = useTemplateActions(
      {
        imported,
        editorDirty: ref(false),
        localBusy: ref(false),
        selectedPlacementId: ref(null),
        normativeRules: ref(PROTOTYPE_RULES),
        onProjectApplied,
      },
      {
        loadCatalog: vi.fn(async () => {
          throw new Error('Учебный отказ каталога')
        }),
      },
      state,
    )
    const other = useProjectSessionUiStore(createPinia())
    const pinning = actions.pinCurrentSigns()
    setActivePinia(createPinia())
    await pinning
    expect(state.signPinMessage.value).toBe('Учебный отказ каталога')
    expect(actions.signPinMessage.value).toBe(state.signPinMessage.value)
    expect(other.signPinMessage).toBe('')
    expect(onProjectApplied).not.toHaveBeenCalled()
  })

  it('does not commit when input changes between the workflow check and its delivery to the UI', async () => {
    const imported = shallowRef(importSchemeJson(raw))
    const post = imported.value.scheme.placements.find((item) => item.kind === 'sign-post')!
    imported.value = {
      ...imported.value,
      scheme: { ...imported.value.scheme, placements: [{ ...post, signIds: ['1.25'] }] },
    }
    const onProjectApplied = vi.fn()
    const actions = useTemplateActions(
      {
        imported,
        editorDirty: ref(false),
        localBusy: ref(false),
        selectedPlacementId: ref(null),
        normativeRules: ref(PROTOTYPE_RULES),
        onProjectApplied,
      },
      {
        loadCatalog() {
          const request = Promise.resolve({
            catalog: { id: 1, documentCode: 'Учебный', edition: '2030' },
            signs: [{ code: '1.25', revision: 2 }],
          })
          // Run after the application continuation, before the UI continuation of its promise.
          void request.then(() =>
            queueMicrotask(() => {
              imported.value = { ...imported.value, scheme: { ...imported.value.scheme } }
            }),
          )
          return request
        },
      },
    )
    await actions.pinCurrentSigns()
    expect(onProjectApplied).not.toHaveBeenCalled()
    expect(actions.signPinMessage.value).toBe('Проект изменился; повторите закрепление.')
  })
})
