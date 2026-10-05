import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import {
  exportSchemeJson,
  importSchemeJson,
  MAX_PROJECT_FILE_BYTES,
  SchemeImportError,
  type ImportResult,
} from '../domain/import'
import type { Scheme } from '../domain/model'
import { reportError } from '../services/diagnostics'
import { rebuildTemplatePlacements, TemplateBuildError } from '../domain/template-placements'
import { useNormativeRules } from './useNormativeRules'
import { clearPinsAfterSignChange, pinSignImages, usedSignCodes } from '../domain/sign-images'
import {
  getLocalProject,
  listRecoveryDrafts,
  restoreLocalRevision,
  saveLocalProject,
  createRecoveryRepository,
} from '../services/local-projects'
import type { SchemeDetailsDraft } from '../domain/edit-details'
import type { PlacementDraft } from '../domain/edit-placements'
import { RecoverySession, RECOVERY_HEARTBEAT_MS } from '../application/recovery-session'
import { useProjectRevisionActions } from './useProjectRevisionActions'
import type { RevisionCursor } from '../application/project-revisions'
import type { RecoverySummary } from '../domain/recovery'
import {
  recordEdit,
  redoEdit,
  startHistory,
  undoEdit,
  type EditHistory,
} from '../domain/edit-history'

/** Owns the open project, edit history and local draft lifecycle for one editor window. */
const PU66_LINKED_WARNING =
  'Локальная карточка ПУ-66 закреплена как снимок; её актуальность нужно проверить.'

export function useProjectSession(onProjectOpened: () => void) {
  const { rules: normativeRules } = useNormativeRules()
  const imported = shallowRef<ImportResult | null>(null)
  const selectedFileName = ref('')
  const errorMessage = ref('')
  const loading = ref(false)
  const detailsDirty = ref(false)
  const placementDirty = ref(false)
  const modifiedSinceLocalSave = ref(false)
  const localRevision = ref<number | null>(null)
  const localBusy = ref(false)
  const localError = ref('')
  const localNotice = ref('')
  const projectsRefreshKey = ref(0)
  const history = shallowRef<EditHistory<Scheme> | null>(null)
  const selectedPlacementId = ref<number | null>(null)
  const templateMessage = ref('')
  const templateError = ref('')
  const signPinMessage = ref('')
  const editorDirty = computed(() => detailsDirty.value || placementDirty.value)
  const hasUnsavedWork = computed(() => editorDirty.value || modifiedSinceLocalSave.value)
  const recoveryCopies = ref<RecoverySummary[]>([])
  const recoveryStatus = ref<'idle' | 'pending' | 'saving' | 'saved' | 'error'>('idle')
  const recoverySeed = shallowRef<{
    details: SchemeDetailsDraft | null
    placement: PlacementDraft | null
  } | null>(null)
  const pendingDetails = shallowRef<SchemeDetailsDraft | null>(null)
  const pendingPlacement = shallowRef<PlacementDraft | null>(null)
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
    recoverySeed.value = null
    pendingDetails.value = null
    pendingPlacement.value = null
    recoveryStatus.value = 'idle'
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
    imported.value = null
    history.value = null
    selectedPlacementId.value = null
    detailsDirty.value = false
    placementDirty.value = false
    modifiedSinceLocalSave.value = false
    localRevision.value = null
    localError.value = ''
    localNotice.value = ''
    errorMessage.value = ''
    selectedFileName.value = file.name

    if (file.size > MAX_PROJECT_FILE_BYTES) {
      errorMessage.value = 'Файл проекта больше 32 МБ.'
      return
    }

    loading.value = true
    try {
      imported.value = importSchemeJson(await file.text())
      history.value = startHistory(imported.value.scheme)
      selectedPlacementId.value = imported.value.scheme.placements[0]?.id ?? null
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

  function downloadJson(content: string, suffix: string): void {
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

  function saveV5(): void {
    if (imported.value && !editorDirty.value) {
      downloadJson(exportSchemeJson(imported.value.scheme), 'v7')
    }
  }

  function saveOriginal(): void {
    if (imported.value?.scheme.source.kind === 'legacy-html-v1') {
      downloadJson(imported.value.scheme.source.originalJson, 'original_v1')
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
    imported.value = {
      scheme,
      format: 'scheme-v8',
      warnings: [
        PU66_LINKED_WARNING,
        'Вариант выбран по длине фронта работ, нормативная проверка и расстановка знаков не выполнены.',
        ...(scheme.parameters.workZones[scheme.template.code]?.workMetres === 30
          ? ['Ровно 30 м: требуется предметная сверка применимости варианта.']
          : []),
      ],
    }
    history.value = startHistory(scheme)
    selectedPlacementId.value = null
    selectedFileName.value = 'Новый проект · не сохранён'
    localRevision.value = null
    detailsDirty.value = false
    placementDirty.value = false
    modifiedSinceLocalSave.value = true
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
    if (localError.value.includes('Запись изменилась')) {
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

  function openProjectRecord(scheme: Scheme, revision: number): void {
    beginSession()
    imported.value = {
      scheme,
      format: 'scheme-v8',
      warnings: ['Схема не прошла нормативную проверку.'],
    }
    history.value = startHistory(scheme)
    selectedPlacementId.value = scheme.placements[0]?.id ?? null
    selectedFileName.value = `Сохранённый проект · версия ${revision}`
    localRevision.value = revision
    detailsDirty.value = false
    placementDirty.value = false
    modifiedSinceLocalSave.value = false
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
      openProjectRecord(record.scheme, record.revision)
    } catch (cause) {
      showLocalError(cause)
    } finally {
      localBusy.value = false
    }
  }

  function onProjectApplied(scheme: Scheme): void {
    if (!imported.value) return
    scheme = clearPinsAfterSignChange(imported.value.scheme, scheme)
    history.value = recordEdit(history.value ?? startHistory(imported.value.scheme), scheme)
    imported.value = { ...imported.value, scheme }
    detailsDirty.value = false
    placementDirty.value = false
    modifiedSinceLocalSave.value = true
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
      const [signResponse, catalogResponse] = await Promise.all([
        fetch('/api/signs'),
        fetch('/api/signs/catalog'),
      ])
      if (!signResponse.ok || !catalogResponse.ok)
        throw new Error('Локальный каталог PNG недоступен.')
      const signs = (await signResponse.json()) as Array<{ code: string; revision: number }>
      const catalog = (await catalogResponse.json()) as {
        id: number
        documentCode: string
        edition: string
      } | null
      if (!Array.isArray(signs) || !catalog || catalog.edition === 'не указана') {
        throw new Error('Укажите редакцию ГОСТ при импорте каталога знаков.')
      }
      if (imported.value?.scheme !== schemeAtStart)
        throw new Error('Проект изменился; повторите закрепление.')
      const pinned = pinSignImages(schemeAtStart, catalog, signs)
      onProjectApplied(pinned)
      signPinMessage.value = `Закреплены редакции ${usedSignCodes(pinned).length} кодов PNG. Сохраните проект.`
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
    if (!imported.value || !history.value || editorDirty.value || !history.value.past.length) return
    history.value = undoEdit(history.value)
    imported.value = { ...imported.value, scheme: history.value.present }
    modifiedSinceLocalSave.value = true
  }

  function stepForward(): void {
    if (!imported.value || !history.value || editorDirty.value || !history.value.future.length)
      return
    history.value = redoEdit(history.value)
    imported.value = { ...imported.value, scheme: history.value.present }
    modifiedSinceLocalSave.value = true
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
      imported.value = {
        scheme: record.scheme,
        format: 'scheme-v8',
        warnings: ['Восстановлена рабочая копия; проверьте ввод и сохраните проект.'],
      }
      history.value = startHistory(record.scheme)
      selectedPlacementId.value =
        record.placementDraft?.id ?? record.scheme.placements[0]?.id ?? null
      selectedFileName.value = record.fileName
      localRevision.value = record.baseRevision
      modifiedSinceLocalSave.value = true
      detailsDirty.value = false
      placementDirty.value = false
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
    saveV5,
    saveOriginal,
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
