import { ref, type Ref } from 'vue'
import type { ImportResult } from '../domain/import'
import type { Scheme } from '../domain/model'
import type { NormativeRules } from '../domain/normative-parameters'
import { autoRebuildTemplate } from '../domain/template-rebuild'
import { rebuildTemplatePlacements, TemplateBuildError } from '../domain/template-placements'
import { usedSignCodes } from '../domain/sign-images'
import { PinProjectSigns, type SignCatalogRepository } from '../application/sign-pinning'
import { reportError } from '../services/diagnostics'

export interface TemplateEditor {
  imported: Readonly<Ref<ImportResult | null>>
  editorDirty: Readonly<Ref<boolean>>
  localBusy: Readonly<Ref<boolean>>
  selectedPlacementId: Ref<number | null>
  normativeRules: Readonly<Ref<NormativeRules>>
  onProjectApplied(scheme: Scheme): void
}

/** UI feedback and selection around the existing pure template rules and pinning workflow. */
export function useTemplateActions(editor: TemplateEditor, repository: SignCatalogRepository) {
  const {
    imported,
    editorDirty,
    localBusy,
    selectedPlacementId,
    normativeRules,
    onProjectApplied,
  } = editor
  const templateMessage = ref('')
  const templateError = ref('')
  const signPinMessage = ref('')
  /**
   * Правки этапа 2: если шаблон уже собран и изменились параметры раскладки, типовые объекты
   * перестраиваются в том же действии истории (П5, issue #106). Ручные объекты не трогаются.
   */
  function onDetailsApplied(scheme: Scheme): void {
    if (!imported.value) return
    let result: ReturnType<typeof autoRebuildTemplate>
    try {
      result = autoRebuildTemplate(imported.value.scheme, scheme, normativeRules.value)
    } catch (cause) {
      // Непредвиденная ошибка перестройки не должна терять применённые правки этапа 2.
      reportError('Перестройка шаблона после правок этапа 2', cause)
      result = {
        kind: 'failed',
        message:
          'Правки применены, но типовые объекты не перестроены и остались прежними. Соберите шаблон на этапе 3.',
      }
    }
    templateMessage.value = ''
    templateError.value = ''
    const applied = result.kind === 'rebuilt' ? result.scheme : scheme
    onProjectApplied(applied)
    if (result.kind === 'rebuilt') {
      templateMessage.value = result.message
      if (!applied.placements.some((placement) => placement.id === selectedPlacementId.value))
        selectedPlacementId.value = null
    }
    if (result.kind === 'failed') templateError.value = result.message
  }

  function buildDraftTemplate(): void {
    if (!imported.value || editorDirty.value || localBusy.value) return
    templateMessage.value = ''
    templateError.value = ''
    try {
      const {
        scheme: rebuilt,
        keptSlots,
        staleSlots,
      } = rebuildTemplatePlacements(imported.value.scheme, normativeRules.value)
      onProjectApplied(rebuilt)
      selectedPlacementId.value = null
      templateMessage.value =
        'Черновая расстановка обновлена; ручные объекты сохранены. Сверьте каждый знак, место и расстояние.' +
        (keptSlots
          ? ` Объектов шаблона, изменённых вручную и оставленных без замены: ${keptSlots}; проверьте, соответствуют ли они новым параметрам.`
          : '') +
        (staleSlots
          ? ` Вручную изменённых объектов прежней версии шаблона: ${staleSlots}. Новая раскладка их не заменяет — удалите лишние, если они повторяют новые стойки.`
          : '')
    } catch (cause) {
      templateError.value =
        cause instanceof TemplateBuildError
          ? cause.message
          : 'Не удалось собрать черновой шаблон. Проверьте параметры проекта.'
    }
  }

  async function pinCurrentSigns(): Promise<void> {
    if (!imported.value || editorDirty.value || localBusy.value) return
    const schemeAtStart = imported.value.scheme
    signPinMessage.value = ''
    try {
      const pinned = await PinProjectSigns(
        schemeAtStart,
        repository,
        () => imported.value?.scheme ?? null,
      )
      // The workflow's promise adds a delivery microtask; recheck before committing to the UI.
      if (imported.value?.scheme !== schemeAtStart)
        throw new Error('Проект изменился; повторите закрепление.')
      onProjectApplied(pinned)
      signPinMessage.value = `Закреплены версии ${usedSignCodes(pinned).length} кодов PNG. Сохраните проект.`
    } catch (cause) {
      signPinMessage.value = cause instanceof Error ? cause.message : 'Не удалось закрепить PNG.'
    }
  }

  return {
    templateMessage,
    templateError,
    signPinMessage,
    onDetailsApplied,
    buildDraftTemplate,
    pinCurrentSigns,
  }
}
