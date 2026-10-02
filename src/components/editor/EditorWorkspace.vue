<script setup lang="ts">
import { computed } from 'vue'
import { templateLabel } from '../../domain/registry'
import type { ReviewFinding } from '../../domain/review-scheme'
import type { ProjectSession } from '../../composables/useProjectSession'
import type { EditorView } from '../../presentation/editor-navigation'
import Pu66Linker from '../Pu66Linker.vue'
import TemplateChoice from '../TemplateChoice.vue'
import SchemeWorkspace from '../SchemeWorkspace.vue'
import PlacementEditor from '../PlacementEditor.vue'
import SchemeReview from '../SchemeReview.vue'
import SchemeDetailsEditor from '../SchemeDetailsEditor.vue'
import SchemeDraftSheet from '../SchemeDraftSheet.vue'
import ProjectDataInspector from '../ProjectDataInspector.vue'
const props = defineProps<{
  session: ProjectSession
  activeView: EditorView
  signCatalogVersion: number
  pu66CatalogVersion: number
}>()
const emit = defineEmits<{ show: [view: EditorView]; navigate: [finding: ReviewFinding] }>()
const {
  imported,
  selectedFileName,
  localRevision,
  editorDirty,
  localBusy,
  history,
  saveAsNew,
  saveV5,
  saveOriginal,
  stepBack,
  stepForward,
  onPu66Linked,
  buildDraftTemplate,
  pinCurrentSigns,
  signPinMessage,
  templateMessage,
  templateError,
  selectedPlacementId,
  onProjectApplied,
  detailsDirty,
  placementDirty,
  recoverySeed,
  pendingPlacement,
  pendingDetails,
  modifiedSinceLocalSave,
} = props.session
const frontMetres = computed(
  () =>
    imported.value?.scheme.parameters.workZones[imported.value.scheme.template.code]?.workMetres,
)
const detailsMode = computed<'source' | 'geometry' | 'title'>(() =>
  props.activeView === 'source' ? 'source' : props.activeView === 'geometry' ? 'geometry' : 'title',
)
const inProject = computed(() =>
  ['source', 'geometry', 'objects', 'review'].includes(props.activeView),
)
</script>

<template>
  <template v-if="imported">
    <div v-show="inProject" class="project-bar">
      <div>
        <span class="eyebrow">{{ selectedFileName }}</span
        ><strong
          >Переезд {{ imported.scheme.crossing.referenceId }} ·
          {{ templateLabel(imported.scheme.template.code) }}</strong
        ><span class="project-meta"
          >Фронт {{ frontMetres ?? 'не указан' }} м · объектов
          {{ imported.scheme.placements.length }} · редакция
          {{ localRevision ?? 'не сохранена' }}</span
        >
      </div>
      <details class="more-actions">
        <summary>Действия с проектом</summary>
        <div class="more-buttons">
          <button type="button" :disabled="editorDirty || localBusy" @click="saveAsNew">
            Сохранить как новый проект
          </button>
          <button type="button" :disabled="editorDirty || localBusy" @click="saveV5">
            Скачать файл проекта (JSON)
          </button>
          <button
            v-if="imported.scheme.source.kind === 'legacy-html-v1'"
            type="button"
            @click="saveOriginal"
          >
            Скачать исходный JSON
          </button>
          <button
            type="button"
            :disabled="editorDirty || localBusy || !history?.past.length"
            @click="stepBack"
          >
            Отменить действие
          </button>
          <button
            type="button"
            :disabled="editorDirty || localBusy || !history?.future.length"
            @click="stepForward"
          >
            Повторить действие
          </button>
        </div>
      </details>
    </div>
    <p v-show="inProject && editorDirty" class="feedback pending" role="status">
      Есть неприменённый ввод. Вернитесь к изменённой форме и нажмите «Применить правки» или
      «Отменить ввод» перед сохранением и печатью.
    </p>

    <section
      v-show="activeView === 'source'"
      class="view stage"
      aria-label="Этап 1. Исходные данные"
    >
      <div class="view-heading">
        <p class="eyebrow">Этап 1 из 4</p>
        <h1>Исходные данные</h1>
        <p>
          Уточните место работ, направления и закрепите разрешённые сведения из локальной карточки
          ПУ-66.
        </p>
      </div>
      <details v-if="imported.warnings.length" class="opening-notes">
        <summary>Сообщения при открытии · {{ imported.warnings.length }}</summary>
        <ul>
          <li v-for="warning in imported.warnings" :key="warning">{{ warning }}</li>
        </ul>
      </details>
      <Pu66Linker
        class="module"
        :scheme="imported.scheme"
        :locked="editorDirty || localBusy"
        :refresh-key="pu66CatalogVersion"
        @apply="onPu66Linked"
      />
    </section>

    <section
      v-show="activeView === 'geometry'"
      class="view stage"
      aria-label="Этап 2. Схема движения"
    >
      <div class="view-heading">
        <p class="eyebrow">Этап 2 из 4</p>
        <h1>Схема движения</h1>
        <p>
          Размеры и параметры выбранного рисунка ОДМ. Изменение чисел не перемещает уже поставленные
          знаки.
        </p>
      </div>
      <div class="variant-summary">
        <span>Вариант по проекту</span
        ><strong>{{ templateLabel(imported.scheme.template.code) }}</strong
        ><span>Фронт {{ frontMetres ?? 'не указан' }} м</span>
      </div>
      <details class="reference">
        <summary>Как выбран Б.33 или Б.34</summary>
        <TemplateChoice />
      </details>
    </section>

    <section
      v-show="activeView === 'objects'"
      class="view stage"
      aria-label="Этап 3. Знаки и объекты"
    >
      <div class="view-heading">
        <p class="eyebrow">Этап 3 из 4</p>
        <h1>Знаки и объекты</h1>
        <p>
          Работайте с условным полем схемы. Свойства выделенного объекта и палитра находятся ниже
          поля.
        </p>
      </div>
      <section class="module" aria-label="Черновая расстановка">
        <h2>Черновая расстановка по Б.33/Б.34</h2>
        <p>
          Укажите местоположение и решение о регулировании на этапе 2. Расстановка по ОДМ
          218.6.019-2016 (рис. Б.33/Б.34) использует условные координаты; проверьте условия дороги и
          применимость каждого знака. Повторная сборка заменит только объекты шаблона, ручные правки
          останутся.
        </p>
        <button type="button" :disabled="editorDirty || localBusy" @click="buildDraftTemplate">
          Собрать черновой шаблон
        </button>
        <button type="button" :disabled="editorDirty || localBusy" @click="pinCurrentSigns">
          Закрепить редакции PNG
        </button>
        <p v-if="signPinMessage" role="status">{{ signPinMessage }}</p>
        <p v-if="templateMessage" role="status">{{ templateMessage }}</p>
        <p v-if="templateError" class="error" role="alert">{{ templateError }}</p>
      </section>
      <SchemeWorkspace
        :key="`workspace-${signCatalogVersion}`"
        class="module"
        :scheme="imported.scheme"
        :selected-id="selectedPlacementId"
        :locked="editorDirty || localBusy"
        @apply="onProjectApplied"
        @select="selectedPlacementId = $event"
      />
      <PlacementEditor
        :key="`placements-${signCatalogVersion}`"
        class="module"
        :scheme="imported.scheme"
        :locked="detailsDirty || localBusy"
        :selected-placement-id="selectedPlacementId"
        :recovery="recoverySeed"
        @apply="onProjectApplied"
        @dirty="placementDirty = $event"
        @draft="pendingPlacement = $event"
        @select="selectedPlacementId = $event"
      />
    </section>

    <section
      v-show="activeView === 'review'"
      class="view stage"
      aria-label="Этап 4. Проверка и лист"
    >
      <div class="view-heading">
        <p class="eyebrow">Этап 4 из 4</p>
        <h1>Проверка и лист A4</h1>
        <p>
          Заполните реквизиты, просмотрите замечания и распечатайте условный черновик для внутренней
          сверки.
        </p>
      </div>
      <SchemeReview
        class="module"
        :scheme="imported.scheme"
        :has-pending-input="editorDirty"
        :locked="localBusy"
        @navigate="emit('navigate', $event)"
        @apply="onProjectApplied"
      />
    </section>

    <SchemeDetailsEditor
      v-show="activeView === 'source' || activeView === 'geometry' || activeView === 'review'"
      class="module details-module"
      :scheme="imported.scheme"
      :mode="detailsMode"
      :recovery="recoverySeed"
      :locked="placementDirty || localBusy"
      @apply="onProjectApplied"
      @dirty="detailsDirty = $event"
      @draft="pendingDetails = $event"
    />
    <SchemeDraftSheet
      v-show="activeView === 'review'"
      :key="`sheet-${signCatalogVersion}`"
      class="module print-host"
      :scheme="imported.scheme"
      :has-pending-input="editorDirty"
      :local-revision="localRevision"
      :modified-since-local-save="modifiedSinceLocalSave"
    />
    <ProjectDataInspector
      v-show="activeView === 'review'"
      class="data-inspector"
      :scheme="imported.scheme"
    />

    <nav v-show="inProject" class="stage-controls" aria-label="Переход между этапами">
      <button v-if="activeView === 'source'" type="button" @click="emit('show', 'projects')">
        ← К проектам
      </button>
      <button v-if="activeView === 'geometry'" type="button" @click="emit('show', 'source')">
        ← Исходные данные
      </button>
      <button v-if="activeView === 'objects'" type="button" @click="emit('show', 'geometry')">
        ← Схема движения
      </button>
      <button v-if="activeView === 'review'" type="button" @click="emit('show', 'objects')">
        ← Знаки и объекты
      </button>
      <button
        v-if="activeView === 'source'"
        type="button"
        class="primary"
        @click="emit('show', 'geometry')"
      >
        К схеме движения →
      </button>
      <button
        v-if="activeView === 'geometry'"
        type="button"
        class="primary"
        @click="emit('show', 'objects')"
      >
        К знакам и объектам →
      </button>
      <button
        v-if="activeView === 'objects'"
        type="button"
        class="primary"
        @click="emit('show', 'review')"
      >
        К проверке и листу →
      </button>
    </nav>
  </template>
</template>

<style scoped src="../../styles/editor-common.css" />
<style scoped src="../../styles/EditorWorkspace.css" />
