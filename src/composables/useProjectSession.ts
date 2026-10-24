import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  exportSchemeJson,
  importSchemeJson,
  MAX_PROJECT_FILE_BYTES,
  SchemeImportError,
  storedFormatWarnings,
} from '../domain/import'
import type { Scheme } from '../domain/model'
import { loadSignCatalogSnapshot } from '../services/local-signs'
import { reportError } from '../services/diagnostics'
import { localApiErrorCode } from '../services/api-error'
import { rebuildTemplatePlacements, TemplateBuildError } from '../domain/template-placements'
import { autoRebuildTemplate } from '../domain/template-rebuild'
import { useNormativeRules } from './useNormativeRules'
import { pinSignImages, usedSignCodes } from '../domain/sign-images'
import {
  getLocalProject,
  listRecoveryDrafts,
  restoreLocalRevision,
  saveLocalProject,
  createRecoveryRepository,
} from '../services/local-projects'
import { RecoverySession, RECOVERY_HEARTBEAT_MS } from '../application/recovery-session'
import { useProjectRevisionActions } from './useProjectRevisionActions'
import type { RevisionCursor } from '../application/project-revisions'
import type { RecoverySummary } from '../domain/recovery'
import { useProjectHistory } from './useProjectHistory'
import { useEditorDraftState } from './useEditorDraftState'
import { useProjectDocument } from './useProjectDocument'

/** Owns the open project, edit history and local draft lifecycle for one editor window. */
const PU66_LINKED_WARNING =
  'Локальная карточка ПУ-66 закреплена как снимок; её актуальность нужно проверить.'

export function useProjectSession(onProjectOpened: () => void) {
  const { rules: normativeRules } = useNormativeRules()
  const drafts = useEditorDraftState()
  const edits = useProjectHistory()
  const projectDocument = useProjectDocument(drafts, edits)
  const {
    imported,
    selectedFileName,
    errorMessage,
    loading,
    modifiedSinceLocalSave,
    localRevision,
    selectedPlacementId,
  } = projectDocument
  const {
    detailsDirty,
    placementDirty,
    pendingDetails,
    pendingPlacement,
    recoverySeed,
    editorDirty,
  } = drafts
  const { history } = edits
  const localBusy = ref(false)
  const localError = ref('')
  const localNotice = ref('')
  const projectsRefreshKey = ref(0)
  const templateMessage = ref('')
  const templateError = ref('')
  const signPinMessage = ref('')
  const hasUnsavedWork = computed(() => editorDirty.value || modifiedSinceLocalSave.value)
  const recoveryCopies = ref<RecoverySummary[]>([])
  const recoveryStatus = ref<'idle' | 'pending' | 'saving' | 'saved' | 'error'>('idle')
  let recoverySessionId: string = crypto.randomUUID()
  const activeRecoveryId = ref(recoverySessionId)
  const recoveryRepository = createRecoveryRepository(crypto.randomUUID())
  const recovery = new RecoverySession(recoveryRepository)
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let recoveryTimer: ReturnType<typeof setTimeout> | null = null
  let recoveryChanges = 0
  let revisionSession = 0
  let revisionEdit = 0
  const revisionCursor = (): RevisionCursor => ({ session: revisionSession, edit: revisionEdit })
  // Synchronous tracking also sees input changed before Vue's next render/watch batch.
  watch(
    [() => imported.value?.scheme, detailsDirty, placementDirty, pendingDetails, pendingPlacement],
    () => revisionEdit++,
    { flush: 'sync' },
  )

  async function refreshRecoveries(): Promise<void> {
    try {
      recoveryCopies.value = await listRecoveryDrafts()
    } catch (cause) {
      showLocalError(cause)
    }
  }

  function cancelRecoveryTimer(): void {
    if (recoveryTimer) clearTimeout(recoveryTimer)
    recoveryTimer = null
  }

  function beginSession(sessionId: string = crypto.randomUUID()): void {
    revisionSession++
    cancelRecoveryTimer()
    if (sessionId !== recoverySessionId)
      void recovery.release(recoverySessionId).catch(showLocalError)
    recoverySessionId = sessionId
    activeRecoveryId.value = sessionId
    drafts.clearPending()
    recoveryStatus.value = 'idle'
    // Итог сборки шаблона относится к открытому проекту и его текущему состоянию.
    templateMessage.value = ''
    templateError.value = ''
  }

  async function clearRecovery(sessionId: string): Promise<void> {
    await recovery.remove(sessionId)
    if (sessionId === recoverySessionId && !hasUnsavedWork.value) recoveryStatus.value = 'idle'
    await refreshRecoveries()
  }

  async function flushRecovery(): Promise<boolean> {
    cancelRecoveryTimer()
    if (!imported.value || !hasUnsavedWork.value) return true
    const sessionId = recoverySessionId
    const change = recoveryChanges
    const snapshot = {
      sessionId,
      scheme: imported.value.scheme,
      baseRevision: localRevision.value,
      detailsDraft: pendingDetails.value,
      placementDraft: pendingPlacement.value,
      fileName: selectedFileName.value,
    }
    recoveryStatus.value = 'saving'
    const write = recovery.save(snapshot)
    try {
      await write
      if (sessionId === recoverySessionId) {
        if (change === recoveryChanges) recoveryStatus.value = 'saved'
        else scheduleRecovery()
      }
      await refreshRecoveries()
      return true
    } catch (cause) {
      if (sessionId === recoverySessionId) {
        recoveryStatus.value = 'error'
        showLocalError(cause)
      }
      return false
    }
  }

  function scheduleRecovery(): void {
    recoveryChanges++
    cancelRecoveryTimer()
    if (!imported.value || !hasUnsavedWork.value) {
      if (recovery.version(recoverySessionId) > 0) {
        void clearRecovery(recoverySessionId).catch(showLocalError)
      } else recoveryStatus.value = 'idle'
      return
    }
    recoveryStatus.value = 'pending'
    recoveryTimer = setTimeout(() => void flushRecovery(), 800)
  }

  watch(
    [
      imported,
      detailsDirty,
      placementDirty,
      pendingDetails,
      pendingPlacement,
      modifiedSinceLocalSave,
      localRevision,
    ],
    scheduleRecovery,
  )

  function beforeUnload(event: BeforeUnloadEvent): void {
    if (hasUnsavedWork.value && recoveryStatus.value !== 'saved') event.preventDefault()
  }

  function releaseOnExit(): void {
    if (recovery.version(recoverySessionId)) recoveryRepository.releaseOnExit(recoverySessionId)
  }

  async function heartbeat(): Promise<void> {
    const id = recoverySessionId
    try {
      await recovery.heartbeat(id)
    } catch (cause) {
      if (id === recoverySessionId) {
        recoveryStatus.value = 'error'
        showLocalError(cause)
      }
    }
    await refreshRecoveries()
  }

  function onVisible(): void {
    if (document.visibilityState === 'visible') void heartbeat()
  }

  onMounted(() => {
    window.addEventListener('beforeunload', beforeUnload)
    window.addEventListener('pagehide', releaseOnExit)
    window.addEventListener('pageshow', onVisible)
    document.addEventListener('visibilitychange', onVisible)
    heartbeatTimer = setInterval(() => void heartbeat(), RECOVERY_HEARTBEAT_MS)
    void refreshRecoveries()
  })
  onUnmounted(() => {
    revisionSession++
    window.removeEventListener('beforeunload', beforeUnload)
    window.removeEventListener('pagehide', releaseOnExit)
    window.removeEventListener('pageshow', onVisible)
    document.removeEventListener('visibilitychange', onVisible)
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    void recovery.release(recoverySessionId).catch(showLocalError)
    cancelRecoveryTimer()
  })

  async function onFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    if (
      hasUnsavedWork.value &&
      !window.confirm('Есть правки без сохранённой копии. Открыть другой проект?')
    )
      return
    if (hasUnsavedWork.value && !(await flushRecovery())) return

    beginSession()
    projectDocument.clearDocument(file.name)
    localError.value = ''
    localNotice.value = ''

    if (file.size > MAX_PROJECT_FILE_BYTES) {
      errorMessage.value = 'Файл проекта больше 32 МБ.'
      return
    }

    loading.value = true
    try {
      const result = importSchemeJson(await file.text())
      projectDocument.openDocument({
        result,
        fileName: file.name,
        revision: null,
        modified: false,
        selectedPlacementId: result.scheme.placements[0]?.id ?? null,
      })
      onProjectOpened()
    } catch (error) {
      // Журнал получает только тип ошибки и место кода; имя файла и введённые значения не записываются.
      reportError('Открытие JSON-проекта', error)
      errorMessage.value =
        error instanceof SchemeImportError ? error.message : 'Не удалось прочитать выбранный файл.'
    } finally {
      loading.value = false
    }
  }

  function downloadProjectJson(content: string, suffix: string): void {
    const scheme = imported.value?.scheme
    if (!scheme) return

    const crossing = scheme.crossing.referenceId.replace(/[^\p{L}\p{N}_-]/gu, '_').slice(0, 60)
    const url = URL.createObjectURL(new Blob([content], { type: 'application/json;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `scheme_${crossing || 'crossing'}_${suffix}.json`
    document.body.append(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
  }

  function exportCurrentProject(): void {
    if (imported.value && !editorDirty.value) {
      downloadProjectJson(exportSchemeJson(imported.value.scheme), 'v10')
    }
  }

  function exportOriginalProject(): void {
    if (imported.value?.scheme.source.kind === 'legacy-html-v1') {
      downloadProjectJson(imported.value.scheme.source.originalJson, 'original_v1')
    }
  }

  async function createProject(scheme: Scheme): Promise<void> {
    if (scheme.crossing.source !== 'local-pu66') {
      localError.value = 'Новую схему можно начать только с карточки ПУ-66 из локального реестра.'
      return
    }
    if (
      hasUnsavedWork.value &&
      !window.confirm('Есть правки без сохранённой копии. Создать другой проект?')
    )
      return
    if (hasUnsavedWork.value && !(await flushRecovery())) return
    beginSession()
    projectDocument.openDocument({
      result: {
        scheme,
        format: 'scheme-v10',
        warnings: [
          PU66_LINKED_WARNING,
          'Вариант выбран по длине фронта работ, нормативная проверка и расстановка знаков не выполнены.',
        ],
      },
      fileName: 'Новый проект · не сохранён',
      revision: null,
      modified: true,
      selectedPlacementId: null,
    })
    localError.value = ''
    localNotice.value = ''
    errorMessage.value = ''
    onProjectOpened()
  }

  function showLocalError(cause: unknown): void {
    // Текст ответа базы может содержать ключ переезда или имя файла — пишется только тип ошибки.
    reportError('Операция с локальной базой', cause)
    localError.value =
      cause instanceof Error ? cause.message : 'Операция с локальной базой не удалась.'
    if (localApiErrorCode(cause) === 'revision-conflict') {
      localError.value += ' Ваши правки остались открытыми. Обновите список проектов.'
      if (localRevision.value === null) {
        localError.value += ' Для отдельной копии используйте «Сохранить как новый проект».'
      }
    }
  }

  const { saveLocally, saveAsNew, restoreLocal } = useProjectRevisionActions(
    {
      imported,
      history,
      localRevision,
      localBusy,
      loading,
      editorDirty,
      hasUnsavedWork,
      modifiedSinceLocalSave,
      selectedFileName,
      localError,
      localNotice,
      projectsRefreshKey,
      cursor: revisionCursor,
      recoveryId: () => recoverySessionId,
      beginSession,
      openProjectRecord,
      flushRecovery,
      clearRecovery,
      showLocalError,
    },
    { save: saveLocalProject, restore: restoreLocalRevision },
  )

  function openProjectRecord(scheme: Scheme, revision: number, storedSchemaVersion?: number): void {
    beginSession()
    projectDocument.openDocument({
      result: {
        scheme,
        format: 'scheme-v10',
        warnings: [
          'Схема не прошла нормативную проверку.',
          ...(storedSchemaVersion !== undefined
            ? storedFormatWarnings(storedSchemaVersion, scheme)
            : []),
        ],
      },
      fileName: `Сохранённый проект · версия ${revision}`,
      revision,
      modified: false,
      selectedPlacementId: scheme.placements[0]?.id ?? null,
    })
    onProjectOpened()
  }

  async function openLocal(id: string): Promise<void> {
    if (localBusy.value || loading.value) return
    if (
      hasUnsavedWork.value &&
      !window.confirm('Есть несохранённые правки. Открыть другой проект?')
    )
      return
    if (hasUnsavedWork.value && !(await flushRecovery())) return
    localBusy.value = true
    localError.value = ''
    localNotice.value = ''
    try {
      const record = await getLocalProject(id)
      openProjectRecord(record.scheme, record.revision, record.storedSchemaVersion)
    } catch (cause) {
      showLocalError(cause)
    } finally {
      localBusy.value = false
    }
  }

  const onProjectApplied = projectDocument.commitScheme

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
      const { signs, catalog } = await loadSignCatalogSnapshot()
      if (!Array.isArray(signs) || !catalog || catalog.edition === 'не указана') {
        throw new Error('Укажите версию ГОСТ при импорте каталога знаков.')
      }
      if (imported.value?.scheme !== schemeAtStart)
        throw new Error('Проект изменился; повторите закрепление.')
      const pinned = pinSignImages(schemeAtStart, catalog, signs)
      onProjectApplied(pinned)
      signPinMessage.value = `Закреплены версии ${usedSignCodes(pinned).length} кодов PNG. Сохраните проект.`
    } catch (cause) {
      signPinMessage.value = cause instanceof Error ? cause.message : 'Не удалось закрепить PNG.'
    }
  }

  function onPu66Linked(scheme: Scheme): void {
    onProjectApplied(scheme)
    if (!imported.value) return
    imported.value = {
      ...imported.value,
      warnings: [
        ...imported.value.warnings.filter(
          (warning) => !warning.startsWith('Локальная карточка ПУ-66 закреплена'),
        ),
        PU66_LINKED_WARNING,
      ],
    }
  }

  function stepBack(): void {
    if (!projectDocument.stepHistory('back')) return
    templateMessage.value = ''
    templateError.value = ''
  }

  function stepForward(): void {
    if (!projectDocument.stepHistory('forward')) return
    templateMessage.value = ''
    templateError.value = ''
  }

  async function openRecovery(sessionId: string): Promise<void> {
    if (localBusy.value || loading.value) return
    if (
      hasUnsavedWork.value &&
      !window.confirm('Есть правки без сохранённой копии. Открыть копию восстановления?')
    )
      return
    if (hasUnsavedWork.value && !(await flushRecovery())) return
    localBusy.value = true
    localError.value = ''
    try {
      const version = recoveryCopies.value.find((copy) => copy.sessionId === sessionId)?.version
      if (!version) throw new Error('Обновите список копий восстановления.')
      const record = await recovery.claim(sessionId, version)
      beginSession(record.sessionId)
      projectDocument.openDocument({
        result: {
          scheme: record.scheme,
          format: 'scheme-v10',
          warnings: ['Восстановлена рабочая копия; проверьте ввод и сохраните проект.'],
        },
        fileName: record.fileName,
        revision: record.baseRevision,
        modified: true,
        selectedPlacementId: record.placementDraft?.id ?? record.scheme.placements[0]?.id ?? null,
      })
      onProjectOpened()
      await nextTick()
      pendingDetails.value = record.detailsDraft
      pendingPlacement.value = record.placementDraft
      recoverySeed.value = { details: record.detailsDraft, placement: record.placementDraft }
      localNotice.value = 'Рабочая копия восстановлена. Примените ввод в форме и сохраните проект.'
    } catch (cause) {
      showLocalError(cause)
    } finally {
      localBusy.value = false
    }
  }

  async function discardRecovery(sessionId: string, version: number): Promise<void> {
    if (localBusy.value || sessionId === recoverySessionId) return
    localBusy.value = true
    localError.value = ''
    try {
      await recovery.remove(sessionId, version)
      await refreshRecoveries()
    } catch (cause) {
      showLocalError(cause)
    } finally {
      localBusy.value = false
    }
  }

  return {
    imported,
    selectedFileName,
    errorMessage,
    loading,
    detailsDirty,
    placementDirty,
    modifiedSinceLocalSave,
    localRevision,
    localBusy,
    localError,
    localNotice,
    projectsRefreshKey,
    history,
    selectedPlacementId,
    templateMessage,
    templateError,
    onDetailsApplied,
    signPinMessage,
    editorDirty,
    hasUnsavedWork,
    recoveryCopies,
    activeRecoveryId,
    recoveryStatus,
    recoverySeed,
    pendingDetails,
    pendingPlacement,
    openRecovery,
    discardRecovery,
    onFileSelected,
    exportCurrentProject,
    exportOriginalProject,
    /** @deprecated Use exportCurrentProject. Kept during the compatible session refactoring. */
    saveV5: exportCurrentProject,
    /** @deprecated Use exportOriginalProject. */
    saveOriginal: exportOriginalProject,
    createProject,
    saveLocally,
    saveAsNew,
    openLocal,
    restoreLocal,
    onProjectApplied,
    buildDraftTemplate,
    pinCurrentSigns,
    onPu66Linked,
    stepBack,
    stepForward,
  }
}

/** Shared refs and commands for the one editor window; child views never construct a session. */
export type ProjectSession = ReturnType<typeof useProjectSession>
