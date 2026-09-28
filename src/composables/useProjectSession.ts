import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import {
  exportSchemeJson,
  importSchemeJson,
  MAX_PROJECT_FILE_BYTES,
  SchemeImportError,
  type ImportResult,
} from '../domain/import'
import type { Scheme } from '../domain/model'
import { schemeSchema } from '../domain/model'
import { rebuildTemplatePlacements, TemplateBuildError } from '../domain/template-placements'
import { clearPinsAfterSignChange, pinSignImages, usedSignCodes } from '../domain/sign-images'
import { getLocalProject, restoreLocalRevision, saveLocalProject } from '../services/local-projects'
import {
  recordEdit,
  redoEdit,
  startHistory,
  undoEdit,
  type EditHistory,
} from '../domain/edit-history'

/** Owns the open project, edit history and local draft lifecycle for one editor window. */
export function useProjectSession(onProjectOpened: () => void) {
  const imported = shallowRef<ImportResult | null>(null)
  const selectedFileName = ref('')
  const errorMessage = ref('')
  const loading = ref(false)
  const detailsDirty = ref(false)
  const placementDirty = ref(false)
  const modifiedSinceDownload = ref(false)
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
  const hasUnsavedWork = computed(
    () => editorDirty.value || (modifiedSinceDownload.value && modifiedSinceLocalSave.value),
  )

  function beforeUnload(event: BeforeUnloadEvent): void {
    if (hasUnsavedWork.value) event.preventDefault()
  }

  onMounted(() => window.addEventListener('beforeunload', beforeUnload))
  onUnmounted(() => window.removeEventListener('beforeunload', beforeUnload))

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

    imported.value = null
    history.value = null
    selectedPlacementId.value = null
    detailsDirty.value = false
    placementDirty.value = false
    modifiedSinceDownload.value = false
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
      downloadJson(exportSchemeJson(imported.value.scheme), 'v5')
      modifiedSinceDownload.value = false
    }
  }

  function saveOriginal(): void {
    if (imported.value?.scheme.source.kind === 'legacy-html-v1') {
      downloadJson(imported.value.scheme.source.originalJson, 'original_v1')
    }
  }

  function createProject(scheme: Scheme): void {
    if (
      hasUnsavedWork.value &&
      !window.confirm('Есть правки без сохранённой копии. Создать другой проект?')
    )
      return
    imported.value = {
      scheme,
      format: 'scheme-v5',
      warnings: [
        'Идентификатор переезда введён вручную; карточка ПУ-66 не сверена.',
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
    modifiedSinceDownload.value = true
    modifiedSinceLocalSave.value = true
    localError.value = ''
    localNotice.value = ''
    errorMessage.value = ''
    onProjectOpened()
  }

  function showLocalError(cause: unknown): void {
    localError.value =
      cause instanceof Error ? cause.message : 'Операция с локальной базой не удалась.'
    if (localError.value.includes('Запись изменилась')) {
      localError.value += ' Ваши правки остались открытыми. Обновите список черновиков.'
      if (localRevision.value === null) {
        localError.value += ' Для отдельной копии используйте «Сохранить как новый черновик».'
      }
    }
  }

  async function saveLocally(): Promise<void> {
    if (!imported.value || editorDirty.value || localBusy.value) return
    localBusy.value = true
    localError.value = ''
    localNotice.value = ''
    try {
      const schemeAtSave = imported.value.scheme
      const saved = await saveLocalProject(schemeAtSave, localRevision.value ?? 0)
      localRevision.value = saved.revision
      if (imported.value.scheme === schemeAtSave) modifiedSinceLocalSave.value = false
      projectsRefreshKey.value++
      localNotice.value = `Черновик сохранён в SQLite: редакция № ${saved.revision}.`
    } catch (cause) {
      showLocalError(cause)
    } finally {
      localBusy.value = false
    }
  }

  async function saveAsNew(): Promise<void> {
    if (!imported.value || editorDirty.value || localBusy.value) return
    localBusy.value = true
    localError.value = ''
    localNotice.value = ''
    try {
      const copy = schemeSchema.parse({
        ...imported.value.scheme,
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
      })
      const saved = await saveLocalProject(copy, 0)
      imported.value = { ...imported.value, scheme: saved.scheme }
      history.value = startHistory(saved.scheme)
      localRevision.value = saved.revision
      modifiedSinceLocalSave.value = false
      modifiedSinceDownload.value = true
      selectedFileName.value = `Локальный черновик · редакция № ${saved.revision}`
      projectsRefreshKey.value++
      localNotice.value =
        'Создан отдельный черновик с новым ID. Скачайте его JSON при необходимости.'
    } catch (cause) {
      showLocalError(cause)
    } finally {
      localBusy.value = false
    }
  }

  function openProjectRecord(scheme: Scheme, revision: number): void {
    imported.value = {
      scheme,
      format: 'scheme-v5',
      warnings: ['Схема не прошла нормативную проверку.'],
    }
    history.value = startHistory(scheme)
    selectedPlacementId.value = scheme.placements[0]?.id ?? null
    selectedFileName.value = `Локальный черновик · редакция № ${revision}`
    localRevision.value = revision
    detailsDirty.value = false
    placementDirty.value = false
    modifiedSinceDownload.value = false
    modifiedSinceLocalSave.value = false
    onProjectOpened()
  }

  async function openLocal(id: string): Promise<void> {
    if (localBusy.value || loading.value) return
    if (
      hasUnsavedWork.value &&
      !window.confirm('Есть правки без сохранённой копии. Открыть черновик?')
    )
      return
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

  async function restoreLocal(
    id: string,
    sourceRevision: number,
    expectedRevision: number,
  ): Promise<void> {
    if (
      localBusy.value ||
      imported.value?.scheme.id !== id ||
      localRevision.value !== expectedRevision
    )
      return
    if (
      !window.confirm(
        `Восстановить редакцию № ${sourceRevision} как новую редакцию проекта? Несохранённые правки в открытой вкладке будут заменены; сохранённая текущая редакция останется в истории.`,
      )
    )
      return
    localBusy.value = true
    localError.value = ''
    localNotice.value = ''
    try {
      const record = await restoreLocalRevision(id, sourceRevision, expectedRevision)
      openProjectRecord(record.scheme, record.revision)
      projectsRefreshKey.value++
      localNotice.value = `Редакция № ${sourceRevision} восстановлена как № ${record.revision}.`
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
    modifiedSinceDownload.value = true
    modifiedSinceLocalSave.value = true
  }

  function buildDraftTemplate(): void {
    if (!imported.value || editorDirty.value || localBusy.value) return
    templateMessage.value = ''
    templateError.value = ''
    try {
      const rebuilt = rebuildTemplatePlacements(imported.value.scheme)
      onProjectApplied(rebuilt)
      selectedPlacementId.value = null
      templateMessage.value =
        'Черновая расстановка обновлена; ручные объекты сохранены. Сверьте каждый знак, место и расстояние.'
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
          (warning) =>
            warning !== 'Идентификатор переезда введён вручную; карточка ПУ-66 не сверена.' &&
            !warning.startsWith('Локальная карточка ПУ-66 закреплена'),
        ),
        'Локальная карточка ПУ-66 закреплена как снимок; её актуальность нужно проверить.',
      ],
    }
  }

  function stepBack(): void {
    if (!imported.value || !history.value || editorDirty.value || !history.value.past.length) return
    history.value = undoEdit(history.value)
    imported.value = { ...imported.value, scheme: history.value.present }
    modifiedSinceDownload.value = true
    modifiedSinceLocalSave.value = true
  }

  function stepForward(): void {
    if (!imported.value || !history.value || editorDirty.value || !history.value.future.length)
      return
    history.value = redoEdit(history.value)
    imported.value = { ...imported.value, scheme: history.value.present }
    modifiedSinceDownload.value = true
    modifiedSinceLocalSave.value = true
  }

  return {
    imported,
    selectedFileName,
    errorMessage,
    loading,
    detailsDirty,
    placementDirty,
    modifiedSinceDownload,
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
