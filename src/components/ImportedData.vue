<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

const props = defineProps<{ referencedSignIds: string[] }>()
type Sign = { code: string; width: number; height: number }
type Crossing = {
  referenceId: string
  location: string
  section: string
  roadName: string
  crossingWidthMetres: number | string | null
  crossingRoadLengthMetres: number | string | null
  carCountPerDay: number | string | null
  busRoutes: number | string | null
  revision: number
  updatedAt: string
}
const signs = ref<Sign[]>([])
const crossings = ref<Crossing[]>([])
const search = ref('')
const error = ref('')
const busy = ref(false)

const visible = computed(() =>
  signs.value
    .filter((sign) => sign.code.toLowerCase().includes(search.value.trim().toLowerCase()))
    .slice(0, 48),
)
const referenced = computed(() =>
  props.referencedSignIds.map((code) => ({
    code,
    found: signs.value.some((sign) => sign.code === code),
  })),
)

async function load(): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    const [cardsResponse, signsResponse] = await Promise.all([
      fetch('/api/pu66'),
      fetch('/api/signs'),
    ])
    if (!cardsResponse.ok || !signsResponse.ok)
      throw new Error('Не удалось прочитать локальный каталог.')
    crossings.value = (await cardsResponse.json()) as Crossing[]
    signs.value = (await signsResponse.json()) as Sign[]
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Локальный каталог недоступен.'
  } finally {
    busy.value = false
  }
}

function imageUrl(sign: Sign): string {
  return `/api/signs/${encodeURIComponent(sign.code)}/image`
}

onMounted(load)
</script>

<template>
  <section class="imported" aria-labelledby="imported-title">
    <h2 id="imported-title">Импортированные локальные каталоги</h2>
    <p>
      Загрузите разрешённые файлы командами из TESTING.MD на своём компьютере. После импорта
      обновите списки. Здесь показана краткая сводка для составителя; отдельная выборка для схемы
      содержит только её реквизиты. Полная исходная книга хранится в локальной базе.
    </p>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <button type="button" :disabled="busy" @click="load">Обновить каталоги</button>

    <h3>Локальная сверка импортированных карточек</h3>
    <p v-if="crossings.length === 0">Импортированных карточек пока нет.</p>
    <ul v-else>
      <li v-for="card in crossings" :key="card.referenceId">
        <strong>{{ card.location }}</strong> ({{ card.section }}) —
        {{ card.roadName || 'дорога не указана' }}. Ширина:
        {{ card.crossingWidthMetres ?? 'не указана' }} м; длина пересечения:
        {{ card.crossingRoadLengthMetres ?? 'не указана' }} м; автомобили в сутки:
        {{ card.carCountPerDay ?? 'не указано' }}.
        <small>Локальный ключ: {{ card.referenceId }}; редакция {{ card.revision }}.</small>
      </li>
    </ul>

    <h3>Каталог дорожных знаков</h3>
    <p>Найдено {{ signs.length }} знаков. Поиск показывает первые 48 совпадений.</p>
    <label for="sign-search">Номер знака</label>
    <input id="sign-search" v-model="search" type="search" placeholder="Например, 3.24_40_ж" />

    <div v-if="referenced.length" class="referenced">
      <h4>Знаки открытого JSON-проекта</h4>
      <ul>
        <li v-for="item in referenced" :key="item.code">
          {{ item.code }} — {{ item.found ? 'есть в каталоге' : 'не найден в каталоге' }}
        </li>
      </ul>
    </div>
    <div class="gallery">
      <figure v-for="sign in visible" :key="sign.code">
        <img :src="imageUrl(sign)" :alt="`Знак ${sign.code}`" loading="lazy" />
        <figcaption>{{ sign.code }}</figcaption>
      </figure>
    </div>
  </section>
</template>

<style scoped>
.imported {
  margin: 1rem 0;
  padding: 2rem;
  background: #fff;
  border: 1px solid #d8e1eb;
  border-radius: 0.8rem;
}
h2 {
  margin-top: 0;
}
.error {
  color: #a22030;
  font-weight: 600;
}
small {
  color: #526273;
}
small {
  display: block;
}
li {
  margin: 0.5rem 0;
}
button {
  padding: 0.55rem 0.8rem;
  border: 1px solid #185ca5;
  border-radius: 0.35rem;
  background: #fff;
  color: #185ca5;
  cursor: pointer;
  font: inherit;
}
input[type='search'] {
  margin: 0.4rem 0.8rem;
  padding: 0.55rem;
  border: 1px solid #93a5b8;
  border-radius: 0.35rem;
  font: inherit;
}
.gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(8rem, 1fr));
  gap: 0.7rem;
  max-height: 34rem;
  overflow: auto;
}
figure {
  margin: 0;
  padding: 0.8rem;
  border: 1px solid #d8e1eb;
  border-radius: 0.4rem;
  text-align: center;
}
img {
  width: 100%;
  height: 6rem;
  object-fit: contain;
}
</style>
