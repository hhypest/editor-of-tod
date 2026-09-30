<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { helpSections, searchHelp, splitLabels, type HelpSection } from '../help/help-content'

const props = defineProps<{
  /** Раздел, который нужно показать при открытии справки. */
  section: string | null
  /** Меняется при каждом открытии справки, чтобы прокрутить к разделу повторно. */
  openKey: number
}>()

const query = ref('')
const found = computed(() => searchHelp(query.value))
const groups = computed(() => {
  const result: Array<{ name: string; sections: HelpSection[] }> = []
  for (const section of helpSections) {
    const group = result.find((item) => item.name === section.group)
    if (group) group.sections.push(section)
    else result.push({ name: section.group, sections: [section] })
  }
  return result
})
const current = ref<string | null>(null)

async function show(id: string): Promise<void> {
  current.value = id
  await nextTick()
  document.getElementById(`help-${id}`)?.scrollIntoView({ block: 'start' })
}

function choose(id: string): void {
  // Раздел может быть скрыт поиском: оглавление показывает его независимо от запроса.
  if (!found.value.some((section) => section.id === id)) query.value = ''
  void show(id)
}

watch(
  () => [props.section, props.openKey] as const,
  ([section]) => {
    if (section) void show(section)
  },
  { immediate: true },
)
</script>

<template>
  <section class="view help" aria-labelledby="help-heading">
    <div class="view-heading">
      <p class="eyebrow">Отдельный раздел</p>
      <h1 id="help-heading">Справка</h1>
      <p>
        Как пользоваться редактором: от первой настройки реестров до печати листа. Кнопка «Справка»
        в верхней панели открывает раздел по текущему экрану.
      </p>
    </div>
    <div class="help-layout">
      <nav class="toc" aria-label="Оглавление справки">
        <label class="search"
          >Поиск по справке
          <input v-model="query" type="search" placeholder="Например, PNG или сверка" />
        </label>
        <div v-for="group in groups" :key="group.name" class="toc-group">
          <p>{{ group.name }}</p>
          <ul>
            <li v-for="section in group.sections" :key="section.id">
              <button
                type="button"
                :aria-current="current === section.id ? 'true' : undefined"
                @click="choose(section.id)"
              >
                {{ section.title }}
              </button>
            </li>
          </ul>
        </div>
      </nav>
      <div class="help-body">
        <p v-if="query.trim()" class="search-result" role="status">
          {{
            found.length
              ? `Найдено разделов: ${found.length}.`
              : 'Ничего не найдено. Попробуйте другое слово или очистите поиск.'
          }}
        </p>
        <article
          v-for="section in found"
          :id="`help-${section.id}`"
          :key="section.id"
          class="help-section"
          :class="{ current: current === section.id }"
          :data-help="section.id"
        >
          <h2>{{ section.title }}</h2>
          <template v-for="(block, index) in section.blocks" :key="index">
            <p v-if="'p' in block">
              <template v-for="(part, i) in splitLabels(block.p)" :key="i">
                <span v-if="part.label" class="ui">{{ part.text }}</span
                ><template v-else>{{ part.text }}</template>
              </template>
            </p>
            <ol v-else-if="'steps' in block">
              <li v-for="(item, i) in block.steps" :key="i">
                <template v-for="(part, j) in splitLabels(item)" :key="j">
                  <span v-if="part.label" class="ui">{{ part.text }}</span
                  ><template v-else>{{ part.text }}</template>
                </template>
              </li>
            </ol>
            <ul v-else-if="'list' in block">
              <li v-for="(item, i) in block.list" :key="i">
                <template v-for="(part, j) in splitLabels(item)" :key="j">
                  <span v-if="part.label" class="ui">{{ part.text }}</span
                  ><template v-else>{{ part.text }}</template>
                </template>
              </li>
            </ul>
            <p v-else-if="'note' in block" class="note">
              <template v-for="(part, i) in splitLabels(block.note)" :key="i">
                <span v-if="part.label" class="ui">{{ part.text }}</span
                ><template v-else>{{ part.text }}</template>
              </template>
            </p>
            <p v-else-if="'warn' in block" class="warn">
              <template v-for="(part, i) in splitLabels(block.warn)" :key="i">
                <span v-if="part.label" class="ui">{{ part.text }}</span
                ><template v-else>{{ part.text }}</template>
              </template>
            </p>
            <div v-else-if="'table' in block" class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th v-for="cell in block.table.head" :key="cell">{{ cell }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(row, i) in block.table.rows" :key="i">
                    <td v-for="(cell, j) in row" :key="j">
                      <template v-for="(part, k) in splitLabels(cell)" :key="k">
                        <span v-if="part.label" class="ui">{{ part.text }}</span
                        ><template v-else>{{ part.text }}</template>
                      </template>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <dl v-else-if="'terms' in block">
              <template v-for="[term, meaning] in block.terms" :key="term">
                <dt>{{ term }}</dt>
                <dd>{{ meaning }}</dd>
              </template>
            </dl>
          </template>
        </article>
      </div>
    </div>
  </section>
</template>

<style scoped>
.help-layout {
  display: grid;
  grid-template-columns: minmax(13rem, 17rem) minmax(0, 1fr);
  gap: 1.2rem;
  align-items: start;
}
.toc {
  position: sticky;
  top: 1rem;
  max-height: calc(100vh - 2rem);
  overflow: auto;
  padding: 1rem;
  border: 1px solid #d8e1eb;
  border-radius: 0.6rem;
  background: #fff;
}
.search {
  display: grid;
  gap: 0.3rem;
  margin-bottom: 0.8rem;
  font-weight: 600;
}
.search input {
  padding: 0.45rem;
  border: 1px solid #93a5b8;
  border-radius: 0.35rem;
  font: inherit;
  font-weight: 400;
}
.toc-group p {
  margin: 0.8rem 0 0.3rem;
  color: #526273;
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.toc ul {
  margin: 0;
  padding: 0;
  list-style: none;
}
.toc button {
  width: 100%;
  padding: 0.3rem 0.4rem;
  border: 0;
  border-radius: 0.3rem;
  background: none;
  color: #185ca5;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.toc button:hover,
.toc button[aria-current='true'] {
  background: #eaf2fb;
}
.help-body {
  display: grid;
  gap: 1rem;
  min-width: 0;
}
.help-section {
  scroll-margin-top: 1rem;
  padding: 1.2rem 1.5rem;
  border: 1px solid #d8e1eb;
  border-radius: 0.6rem;
  background: #fff;
  line-height: 1.55;
}
.help-section.current {
  border-color: #185ca5;
}
.help-section h2 {
  margin-top: 0;
  font-size: 1.25rem;
}
.help-section li {
  margin: 0.35rem 0;
}
.ui {
  padding: 0 0.3rem;
  border: 1px solid #c9d6e4;
  border-radius: 0.25rem;
  background: #f3f7fb;
  font-weight: 600;
  white-space: nowrap;
}
.note,
.warn {
  padding: 0.6rem 0.8rem;
  border-left: 3px solid #185ca5;
  background: #eef4fb;
}
.warn {
  border-color: #b7791f;
  background: #fff8e8;
}
.table-wrap {
  overflow-x: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
}
th,
td {
  padding: 0.4rem 0.5rem;
  border-bottom: 1px solid #e3e9f0;
  text-align: left;
  vertical-align: top;
}
th {
  background: #f6f8fb;
}
dl {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.4rem 1rem;
}
dt {
  font-weight: 600;
}
dd {
  margin: 0;
}
.search-result {
  margin: 0;
  color: #526273;
}
@media (max-width: 900px) {
  .help-layout {
    grid-template-columns: 1fr;
  }
  .toc {
    position: static;
    max-height: none;
  }
  .ui {
    white-space: normal;
  }
}
</style>
