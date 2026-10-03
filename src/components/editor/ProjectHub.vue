<script setup lang="ts">
import NewScheme from '../NewScheme.vue'
import LocalProjects from '../LocalProjects.vue'
import type { ProjectSession } from '../../composables/useProjectSession'
import type { ProjectTab, SetupImportTarget } from '../../presentation/editor-navigation'
const props = defineProps<{
  session: ProjectSession
  projectTab: ProjectTab
  active: boolean
  setupStatus: { cards: number; signs: number } | null
  setupError: string
}>()
const emit = defineEmits<{
  'choose-tab': [tab: ProjectTab]
  'setup-import': [target: SetupImportTarget]
  help: [section: string]
}>()
// These refs and commands belong to App's single session; this view creates no session.
const {
  imported,
  recoveryCopies,
  activeRecoveryId,
  localBusy,
  loading,
  openRecovery,
  discardRecovery,
  createProject,
  localRevision,
  projectsRefreshKey,
  openLocal,
  restoreLocal,
  onFileSelected,
  errorMessage,
} = props.session
</script>

<template>
  <section class="view" aria-labelledby="projects-heading">
    <div class="view-heading">
      <p class="eyebrow">Рабочее место</p>
      <h1 id="projects-heading">Проекты схем</h1>
      <p>
        Продолжите сохранённый проект, начните новую схему по карточке ПУ-66 или откройте файл
        проекта (JSON), полученный от коллеги или из прежней версии программы.
      </p>
    </div>
    <section v-if="recoveryCopies.length" class="module" aria-labelledby="recovery-heading">
      <h2 id="recovery-heading">Копии восстановления</h2>
      <p class="hint">
        Здесь остаются правки, которые не успели сохранить до закрытия окна. Копия хранится на этом
        компьютере отдельно от сохранённых версий проекта.
      </p>
      <ul>
        <li v-for="copy in recoveryCopies" :key="copy.sessionId">
          <strong>{{ copy.referenceId }}</strong> · {{ copy.fileName }} ·
          {{ new Date(copy.updatedAt).toLocaleString('ru-RU') }}
          <span v-if="copy.sessionId === activeRecoveryId"> · открыта сейчас</span>
          <span v-else-if="copy.active"> · открыта в другом окне</span>
          <button
            type="button"
            :disabled="localBusy || loading || copy.active"
            @click="openRecovery(copy.sessionId)"
          >
            Восстановить
          </button>
          <button
            type="button"
            :disabled="localBusy || copy.active || copy.sessionId === activeRecoveryId"
            @click="discardRecovery(copy.sessionId, copy.version)"
          >
            Удалить копию
          </button>
        </li>
      </ul>
    </section>
    <section
      v-if="setupStatus && (!setupStatus.signs || !setupStatus.cards)"
      class="setup-guide module"
      aria-labelledby="setup-heading"
    >
      <p class="eyebrow">Первый запуск · локальная SQLite готова</p>
      <h2 id="setup-heading">Наполните реестры на этом компьютере</h2>
      <p>
        Локальная база находится в private-data/registry.sqlite. Добавьте недостающие реестры: знаки
        из PDF ГОСТ Р 52290 и книги ПУ-66. Файлы выбираются с этого компьютера; после просмотра
        изменений подтвердите запись.
      </p>
      <p>
        <button type="button" class="link-button" @click="emit('help', 'first-run')">
          Порядок настройки в справке
        </button>
      </p>
      <ol class="setup-steps">
        <li>
          <strong
            >Знаки: {{ setupStatus.signs ? `${setupStatus.signs} в базе` : 'пока нет' }}</strong
          >
          <p>
            Прикрепите PDF ГОСТ Р 52290 в «Нормативных документах» и извлеките из него знаки (или
            загрузите ZIP с PNG).
          </p>
          <button type="button" @click="emit('setup-import', 'pdf-sign-import')">
            {{ setupStatus.signs ? 'Открыть каталог' : 'Извлечь знаки из PDF' }}
          </button>
        </li>
        <li>
          <strong
            >ПУ-66: {{ setupStatus.cards ? `${setupStatus.cards} в базе` : 'пока нет' }}</strong
          >
          <p>
            Без карточек ПУ-66 новый проект не создаётся. Выберите сразу все XLSX (до 100 книг); для
            пробы можно создать вымышленные книги командой npm run samples:pu66.
          </p>
          <button type="button" @click="emit('setup-import', 'pu66-import')">
            {{ setupStatus.cards ? 'Открыть карточки' : 'Импортировать ПУ-66' }}
          </button>
        </li>
      </ol>
      <p class="hint">
        Импорт не отмечает ежегодную сверку ПУ-66; её регистрирует линейное подразделение после
        фактической проверки.
      </p>
    </section>
    <p v-if="setupError" class="feedback error" role="alert">{{ setupError }}</p>
    <div class="tabs" role="group" aria-label="Способ открытия проекта">
      <button
        type="button"
        :aria-pressed="projectTab === 'local'"
        @click="emit('choose-tab', 'local')"
      >
        Мои проекты
      </button>
      <button type="button" :aria-pressed="projectTab === 'new'" @click="emit('choose-tab', 'new')">
        Новый проект
      </button>
      <button
        type="button"
        :aria-pressed="projectTab === 'file'"
        @click="emit('choose-tab', 'file')"
      >
        Открыть файл
      </button>
    </div>
    <NewScheme
      v-show="projectTab === 'new'"
      class="module"
      :locked="localBusy || loading"
      :active="projectTab === 'new' && active"
      @create="createProject"
      @import-pu66="emit('setup-import', 'pu66-import')"
    />
    <LocalProjects
      v-if="projectTab === 'local'"
      class="module"
      :active-id="imported?.scheme.id ?? null"
      :active-revision="localRevision"
      :refresh-key="projectsRefreshKey"
      :locked="localBusy || loading"
      @open="openLocal"
      @restore="restoreLocal"
      @create="emit('choose-tab', 'new')"
    />
    <section v-show="projectTab === 'file'" class="module" aria-labelledby="import-title">
      <h2 id="import-title">Открыть файл проекта</h2>
      <label for="scheme-file" class="file-label">Файл .json с вашего компьютера</label>
      <input
        id="scheme-file"
        type="file"
        accept=".json,application/json"
        :disabled="localBusy"
        @change="onFileSelected"
      />
      <p class="hint">
        Файл проекта скачивается кнопкой «Скачать файл проекта (JSON)». Подходят файлы всех прежних
        версий программы (v1 и schemaVersion 2–8) размером до 32 МБ. Открытый файл не попадает в
        «Мои проекты», пока вы не нажмёте «Сохранить проект».
      </p>
      <p v-if="loading" class="hint" role="status">Проверяем файл…</p>
      <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
    </section>
  </section>
</template>

<style scoped src="../../styles/editor-common.css" />
<style scoped src="../../styles/ProjectHub.css" />
