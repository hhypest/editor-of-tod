<script setup lang="ts">
import { CROSSING_FRONT_LIMIT_METRES } from '../domain/crossing-limits'
import { templateLabel, selectTemplateByWorkFront } from '../domain/registry'
import { workSectionMetres } from '../domain/work-traffic'
import { frontLimit } from '../domain/work-conditions'
import WorkConditionsFields from './WorkConditionsFields.vue'
import PddSpeedReference from './PddSpeedReference.vue'
import DecisionEvidencePanel from './DecisionEvidencePanel.vue'
import { recordSpeedDecision, recordRegulationDecision } from '../domain/decision-evidence'
import type { SpeedConditions } from '../domain/decision-evidence-schema'
import { computed, ref, watch } from 'vue'
import {
  applySchemeDetails,
  changeDraftApproach,
  changeDraftLocation,
  createSchemeDetailsDraft,
  draftDefaultsFields,
  resetDraftToNormative,
  SchemeEditError,
  type SchemeDetailsDraft,
} from '../domain/edit-details'
import {
  defaultsParameterIds,
  distanceFields,
  distanceTitles,
  normativeMarks,
  speedTitles,
  type DistanceField,
  type NormativeMark as NormativeMarkData,
} from '../domain/normative-defaults'
import { settlementSteps } from '../domain/template-placements'
import NormativeMark from './NormativeMark.vue'
import type { Scheme } from '../domain/model'
import { adviseRegulation, regulationModeLabels } from '../domain/regulation-advice'
import { useNormativeRules } from '../composables/useNormativeRules'
import Pu66NormsPanel from './Pu66NormsPanel.vue'
import { formatPhone, PHONE_PLACEHOLDER } from '../domain/title-block'

const props = defineProps<{
  scheme: Scheme
  locked?: boolean
  mode?: 'source' | 'geometry' | 'title'
  recovery?: { details: SchemeDetailsDraft | null } | null
}>()
const emit = defineEmits<{
  apply: [scheme: Scheme]
  dirty: [value: boolean]
  draft: [value: SchemeDetailsDraft | null]
}>()
const heading = computed(() => {
  if (props.mode === 'source') return 'Место работ и направления'
  if (props.mode === 'geometry') return 'Размеры и параметры схемы'
  if (props.mode === 'title') return 'Реквизиты листа и согласования'
  return 'Параметры и реквизиты проекта'
})
const draft = ref(createSchemeDetailsDraft(props.scheme))
const dirty = ref(false)
const error = ref('')
const status = ref('')
const zoneCodes = ['b33', 'b34'] as const

function addZone(code: 'b33' | 'b34'): void {
  if (props.locked || draft.value.parameters.workZones[code]) return
  draft.value.parameters.workZones[code] = {
    taperMetres: '',
    bufferMetres: '',
    workMetres: '',
    labels: { taper: '', buffer: '', work: '' },
  }
  markDirty()
}

watch(
  () => props.scheme,
  (scheme) => {
    draft.value = createSchemeDetailsDraft(scheme)
    dirty.value = false
    emit('dirty', false)
  },
)

watch(
  () => props.recovery,
  (recovery) => {
    if (!recovery?.details) return
    draft.value = structuredClone(recovery.details)
    draft.value.decisionNotes ??= {
      speed: draft.value.decisionEvidence?.speed?.note ?? '',
      regulation: draft.value.decisionEvidence?.regulation?.note ?? '',
    }
    dirty.value = true
    emit('dirty', true)
  },
)

watch(
  [draft, dirty],
  () => emit('draft', dirty.value ? JSON.parse(JSON.stringify(draft.value)) : null),
  { deep: true, flush: 'post' },
)

function draftNumber(value: string | undefined): number | null {
  const input = (value ?? '').trim().replace(',', '.')
  return /^\d+(?:\.\d+)?$/.test(input) ? Number(input) : null
}

const { rules: normativeRules } = useNormativeRules()

/** Смена местоположения подставляет значения по умолчанию, не трогая исправленные вручную. */
const location = computed({
  get: () => draft.value.parameters.location,
  set: (to) => {
    const from = draft.value.parameters.location
    draft.value.parameters.location = to
    draft.value.parameters.speedConditions = { road: '', vehicle: '' }
    changeDraftLocation(draft.value, from, normativeRules.value)
    markDirty()
  },
})

/** Скорость применяется по завершении ввода (`v-model.lazy`): ступени пересчитываются один раз. */
const approachSpeed = computed({
  get: () => draft.value.parameters.approachSpeedKmh,
  set: (value) => {
    const previous = draft.value.parameters.approachSpeedKmh
    draft.value.parameters.approachSpeedKmh = value
    changeDraftApproach(draft.value, previous, normativeRules.value)
    markDirty()
  },
})

const markList = computed(() =>
  normativeMarks(draftDefaultsFields(draft.value), normativeRules.value),
)
const marks = computed<Record<string, NormativeMarkData>>(() =>
  Object.fromEntries(markList.value.map((item) => [item.field, item])),
)
const hasDeviations = computed(() => markList.value.some((item) => item.state !== 'normative'))
const unconfirmedDefaults = computed(() => {
  const current = draft.value.parameters.location
  if (current === 'auto') return []
  return defaultsParameterIds(current)
    .filter((id) => !normativeRules.value.confirmed[id])
    .map((id) => normativeRules.value.sources[id] ?? id)
    .filter((source, index, all) => all.indexOf(source) === index)
})

/** Промежуточные ступени в населённом пункте строит шаблон — показываем, какими они будут. */
const settlementStepsText = computed(() => {
  const { location: current, approachSpeedKmh, speedStagesKmh } = draft.value.parameters
  if (current !== 'in') return ''
  const approach = draftNumber(approachSpeedKmh)
  const zone = draftNumber(speedStagesKmh[2])
  if (approach === null || zone === null) return ''
  const steps = settlementSteps(approach, zone, normativeRules.value.speedStepKmh)
  return `Знаки 3.24 на подходе: ${[...steps, zone].join(' → ')} км/ч (промежуточные ступени строятся с шагом не более ${normativeRules.value.speedStepKmh} км/ч).`
})

function restore(item: NormativeMarkData): void {
  if (props.locked) return
  if (item.field === 'parameters.approachSpeedKmh') {
    approachSpeed.value = String(item.normative)
    return
  }
  const [, group, key] = item.field.split('.')
  if (group === 'signSize' && typeof item.normative === 'string')
    draft.value.parameters.signSize = item.normative as Scheme['parameters']['signSize']
  else if (group === 'signDistancesMetres')
    draft.value.parameters.signDistancesMetres[key as DistanceField] = String(item.normative)
  else if (group === 'speedStagesKmh')
    draft.value.parameters.speedStagesKmh[Number(key)] = String(item.normative)
  markDirty()
}

function restoreAll(): void {
  if (props.locked) return
  resetDraftToNormative(draft.value, normativeRules.value)
  markDirty()
}

/** Профиль переезда по введённым, ещё не применённым данным формы. */
const advice = computed(() => {
  const { regulation, speedStagesKmh, workZones } = draft.value.parameters
  const zone = workZones[props.scheme.template.code]
  const conditions = draft.value.parameters.workConditions
  const workConditions = {
    ...conditions,
    durationHours: draftNumber(conditions.durationHours),
    sectionMetres: draftNumber(conditions.sectionMetres),
  }
  return adviseRegulation(
    {
      hourly: regulation.hourly,
      limitedVisibility: regulation.vis,
      straight: regulation.straight,
      zoneSpeedKmh: draftNumber(speedStagesKmh[2]),
      taperMetres: draftNumber(zone?.taperMetres),
      frontMetres: draftNumber(zone?.workMetres),
      sectionMetres:
        workConditions.sectionMetres ??
        (zone &&
        [zone.taperMetres, zone.bufferMetres, zone.workMetres].every(
          (value) => draftNumber(value) !== null,
        )
          ? workSectionMetres({
              taperMetres: draftNumber(zone.taperMetres)!,
              bufferMetres: draftNumber(zone.bufferMetres)!,
              workMetres: draftNumber(zone.workMetres)!,
            })
          : null),
      workConditions,
    },
    normativeRules.value,
  )
})
const frontPreview = computed(() => {
  const value = draftNumber(
    draft.value.parameters.workZones[props.scheme.template.code]?.workMetres,
  )
  return value !== null && value > 0
    ? templateLabel(selectTemplateByWorkFront(value).code)
    : 'не определён'
})

function applyAdvice(): void {
  if (props.locked || !advice.value.mode || !advice.value.verified) return
  draft.value.parameters.regulation.mode = advice.value.mode
  markDirty()
  draft.value.decisionNotes ??= { speed: '', regulation: '' }
  draft.value.decisionNotes.regulation = advice.value.reasons.join(' ')
  recordDecision('regulation')
}

function selectSpeedConditions(value: SpeedConditions) {
  if (props.locked) return
  draft.value.parameters.speedConditions = value
  markDirty()
}
function applySpeedReference(value: number) {
  if (props.locked) return
  approachSpeed.value = String(value)
  draft.value.decisionNotes ??= { speed: '', regulation: '' }
  if (!draft.value.decisionNotes.speed)
    draft.value.decisionNotes.speed =
      'Выбран справочник скорости по указанному виду дороги и ТС; состав потока и действующие знаки требуют отдельной сверки.'
  recordDecision('speed')
}
const decisionNotes = computed(() => {
  return draft.value.decisionNotes ?? { speed: '', regulation: '' }
})
const evidencePreview = computed(() => {
  try {
    return applySchemeDetails(props.scheme, draft.value, normativeRules.value)
  } catch {
    return props.scheme
  }
})
function recordDecision(kind: 'speed' | 'regulation') {
  if (props.locked) return
  try {
    const candidate = applySchemeDetails(props.scheme, draft.value, normativeRules.value)
    const updated =
      kind === 'speed'
        ? recordSpeedDecision(candidate, normativeRules.value, decisionNotes.value.speed)
        : recordRegulationDecision(candidate, normativeRules.value, decisionNotes.value.regulation)
    draft.value.decisionEvidence = updated.decisionEvidence
    markDirty()
    error.value = ''
    status.value = 'Основания записаны в вводе формы. Примените правки и сохраните проект.'
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Не удалось записать основания.'
  }
}

function useHourly(value: string): void {
  if (props.locked) return
  draft.value.parameters.regulation.hourly = value
  markDirty()
}

function usePu66Front(): void {
  if (props.locked) return
  const maximum = frontLimit(props.scheme)
  const zone = draft.value.parameters.workZones[props.scheme.template.code]
  if (!zone || maximum === null || maximum <= 0) return
  zone.workMetres = String(maximum)
  draft.value.parameters.frontFromPu66 = true
  markDirty()
}

function useTypesize(value: Scheme['parameters']['signSize']): void {
  if (props.locked) return
  draft.value.parameters.signSize = value
  markDirty()
}

function addResponsible(): void {
  if (props.locked || draft.value.titleBlock.responsible.length >= 2) return
  const [first] = draft.value.titleBlock.responsible
  if (!first) return
  draft.value.titleBlock.responsible = [first, { position: '', name: '', phone: '' }]
  markDirty()
}

function removeResponsible(): void {
  if (props.locked || draft.value.titleBlock.responsible.length < 2) return
  const [first] = draft.value.titleBlock.responsible
  if (first) draft.value.titleBlock.responsible = [first]
  markDirty()
}

/** Маска телефона применяется при наборе: цифры раскладываются в +7 (XXX) XXX-XX-XX. */
function onPhoneInput(index: number, event: Event): void {
  const input = event.target as HTMLInputElement
  const person = draft.value.titleBlock.responsible[index]
  if (!person) return
  person.phone = formatPhone(input.value)
  input.value = person.phone
}

function markDirty(): void {
  if (props.locked) return
  error.value = ''
  status.value = ''
  if (!dirty.value) {
    dirty.value = true
    emit('dirty', true)
  }
}

function discard(): void {
  draft.value = createSchemeDetailsDraft(props.scheme)
  dirty.value = false
  error.value = ''
  status.value = ''
  emit('dirty', false)
}

function applyDraft(): void {
  if (props.locked) return
  try {
    if (
      draft.value.decisionNotes &&
      (['speed', 'regulation'] as const).some(
        (kind) =>
          draft.value.decisionNotes![kind] !== (draft.value.decisionEvidence?.[kind]?.note ?? ''),
      )
    ) {
      throw new SchemeEditError(
        'Запишите изменённое обоснование кнопкой «Записать основания скорости» или «Записать основания регулирования» перед применением правок.',
      )
    }
    const updated = applySchemeDetails(props.scheme, draft.value, normativeRules.value)
    dirty.value = false
    error.value = ''
    status.value = 'Правки применены к проекту. Сохраните проект; файл JSON можно скачать отдельно.'
    emit('apply', updated)
    emit('dirty', false)
  } catch (cause) {
    error.value = cause instanceof SchemeEditError ? cause.message : 'Не удалось применить правки.'
  }
}
</script>

<template>
  <section aria-labelledby="details-title">
    <h2 id="details-title">{{ heading }}</h2>
    <p class="hint">
      Изменения применяются к открытой копии проекта после нажатия «Применить правки». Они не
      переставляют знаки и не подтверждают соответствие схемы нормам.
    </p>
    <form @submit.prevent="applyDraft" @input="markDirty" @change="markDirty">
      <fieldset v-if="!mode || mode === 'source'" :disabled="locked">
        <legend>Место работ</legend>
        <div class="fields">
          <label
            >Участок
            <input
              v-model="draft.parameters.locationText"
              data-field="parameters.locationText"
              type="text"
          /></label>
          <label
            >Направление слева
            <input
              v-model="draft.parameters.directions.left"
              data-field="parameters.directions.left"
              type="text"
          /></label>
          <label
            >Направление справа
            <input
              v-model="draft.parameters.directions.right"
              data-field="parameters.directions.right"
              type="text"
          /></label>
        </div>
      </fieldset>
      <fieldset v-if="!mode || mode === 'geometry'" :disabled="locked">
        <legend>Параметры схемы</legend>
        <p class="hint">
          Расстояния вводятся в метрах, скорости — в км/ч. По введённому фронту будет выбран
          {{ frontPreview }}. Отгон и буфер не меняют вариант. При смене варианта объекты
          сохраняются; соберите шаблон заново и повторите проверку листа.
        </p>
        <p class="hint">
          Предел фронта редактора: {{ CROSSING_FRONT_LIMIT_METRES }} м. Дополнительно фронт
          ограничен п. 8 закреплённой ПУ-66:
          {{ frontLimit(scheme) ?? 'не указан — обновите связь с заполненной карточкой' }} м.
        </p>
        <button
          v-if="(frontLimit(scheme) ?? 0) > 0"
          type="button"
          :disabled="locked"
          @click="usePu66Front"
        >
          Взять фронт из п. 8 ПУ-66
        </button>
        <WorkConditionsFields v-model="draft.parameters.workConditions" />
        <h3>Местоположение, скорость и типоразмер знаков</h3>
        <div class="fields with-marks">
          <label
            ><span class="caption">Местоположение</span>
            <select v-model="location" data-field="parameters.location">
              <option value="auto" disabled>Не определено</option>
              <option value="in">В населённом пункте</option>
              <option value="out">Вне населённого пункта</option>
            </select>
          </label>
          <label
            ><span class="caption">Разрешённая скорость на подходе, км/ч</span>
            <input
              v-model.lazy="approachSpeed"
              data-field="parameters.approachSpeedKmh"
              inputmode="decimal"
              type="text"
            />
            <NormativeMark :mark="marks['parameters.approachSpeedKmh']" @restore="restore" />
          </label>
          <label
            ><span class="caption">Типоразмер знаков</span>
            <select v-model="draft.parameters.signSize" data-field="parameters.signSize">
              <option value="auto">Уточнить</option>
              <option value="I">I</option>
              <option value="II">II</option>
              <option value="III">III</option>
              <option value="IV">IV (работы на дорогах IА, IБ)</option>
            </select>
            <NormativeMark :mark="marks['parameters.signSize']" @restore="restore" />
          </label>
        </div>
        <PddSpeedReference
          :location="draft.parameters.location"
          :rules="normativeRules"
          :locked="locked"
          :selection="draft.parameters.speedConditions ?? { road: '', vehicle: '' }"
          @select="selectSpeedConditions"
          @apply="applySpeedReference"
        />
        <details class="decision-evidence">
          <summary>Обоснование решений и источники</summary>
          <p>
            Запись сохраняет текущие условия и нормативные основания. Для ручного решения укажите
            фактические ограничения и причину выбора. Затем примените правки и сохраните проект.
          </p>
          <label
            >Обоснование скорости
            <textarea
              v-model="decisionNotes.speed"
              data-field="decisionEvidence.speed"
              maxlength="5000"
              :disabled="locked"
            />
          </label>
          <button type="button" :disabled="locked" @click="recordDecision('speed')">
            Записать основания скорости
          </button>
          <label
            >Обоснование регулирования
            <textarea
              v-model="decisionNotes.regulation"
              data-field="decisionEvidence.regulation"
              maxlength="5000"
              :disabled="locked"
            />
          </label>
          <button type="button" :disabled="locked" @click="recordDecision('regulation')">
            Записать основания регулирования
          </button>
          <DecisionEvidencePanel :scheme="evidencePreview" :rules="normativeRules" />
        </details>
        <p class="hint">
          Расстояния и ступени скорости подставляются по нормативным значениям: при выборе
          местоположения и при смене разрешённой скорости. Любое значение можно исправить под
          местные условия — оно сохранится и будет помечено как изменённое.
        </p>
        <p v-if="draft.parameters.location === 'auto'" class="hint warning">
          Выберите местоположение — от него зависят расстояния до знаков и ступени скорости.
        </p>
        <template v-else>
          <h3>Расстояния от стоек до начала работ, м</h3>
          <div class="fields with-marks pairs">
            <label v-for="field in distanceFields[draft.parameters.location]" :key="field"
              ><span class="caption">{{ distanceTitles[field] }}</span>
              <input
                v-model="draft.parameters.signDistancesMetres[field]"
                :data-field="`parameters.signDistancesMetres.${field}`"
                type="text"
                inputmode="decimal"
              />
              <NormativeMark
                :mark="marks[`parameters.signDistancesMetres.${field}`]"
                @restore="restore"
              />
            </label>
          </div>
        </template>
        <h3>Ступени скорости 3.24, км/ч</h3>
        <div class="fields compact with-marks">
          <label v-for="index in draft.parameters.location === 'in' ? [2] : [0, 1, 2]" :key="index"
            ><span class="caption">{{ speedTitles[index] }}</span>
            <input
              v-model="draft.parameters.speedStagesKmh[index]"
              :data-field="`parameters.speedStagesKmh.${index}`"
              type="text"
              inputmode="decimal"
            />
            <NormativeMark :mark="marks[`parameters.speedStagesKmh.${index}`]" @restore="restore" />
          </label>
        </div>
        <p v-if="settlementStepsText" class="hint">{{ settlementStepsText }}</p>
        <div v-if="Object.keys(marks).length || unconfirmedDefaults.length" class="normative">
          <button v-if="hasDeviations" type="button" :disabled="locked" @click="restoreAll">
            Вернуть все нормативные значения
          </button>
          <p v-if="unconfirmedDefaults.length" class="hint">
            Не подтверждены: {{ unconfirmedDefaults.join('; ') }}. Пока действуют значения
            прототипа; подтвердите их в «Реестры» → «Нормативные параметры».
          </p>
        </div>
        <label class="checkbox">
          <input v-model="draft.parameters.yellowTemporarySigns" type="checkbox" />
          Жёлтый фон временных знаков
        </label>
        <h3>Условия и решение составителя</h3>
        <div class="fields">
          <label
            >Вид фронта работ
            <select v-model="draft.parameters.frontStyle">
              <option value="part">Частичный</option>
              <option value="solid">Сплошной</option>
            </select>
          </label>
          <label
            >Регулирование Б.34
            <select v-model="draft.parameters.regulation.mode">
              <option value="auto">Решение не принято</option>
              <option value="signs">Знаки приоритета</option>
              <option value="one">Один регулировщик</option>
              <option value="two">Два регулировщика</option>
            </select>
          </label>
          <label
            >Интенсивность, авт./ч (по данным составителя)
            <input v-model="draft.parameters.regulation.hourly" type="text" />
          </label>
        </div>
        <div class="checks">
          <label class="checkbox"
            ><input :checked="draft.parameters.frontFromPu66" type="checkbox" disabled />
            Фронт взят из ПУ-66 (проверьте размер на месте)
          </label>
          <label class="checkbox"
            ><input v-model="draft.parameters.regulation.vis" type="checkbox" />
            Видимость встречного автомобиля ограничена
          </label>
          <label class="checkbox"
            ><input v-model="draft.parameters.regulation.straight" type="checkbox" />
            Прямой участок; регулировщик виден с обоих концов рабочей зоны
          </label>
        </div>
        <Pu66NormsPanel
          v-if="scheme.crossing.source === 'local-pu66'"
          :reference-id="scheme.crossing.referenceId"
          :pinned-revision="scheme.crossing.snapshot.revision"
          :location="draft.parameters.location"
          :locked="locked"
          @hourly="useHourly"
          @typesize="useTypesize"
        />
        <section
          v-if="scheme.template.code === 'b34'"
          class="advice"
          :class="{ unverified: !advice.verified }"
          aria-labelledby="regulation-advice-title"
          aria-live="polite"
        >
          <h3 id="regulation-advice-title">
            {{
              advice.verified
                ? 'Рекомендация по подтверждённым нормативным параметрам'
                : 'Подсказка с неподтверждёнными параметрами'
            }}:
            {{ advice.mode ? regulationModeLabels[advice.mode] : 'требуется проверка условий' }}
          </h3>
          <p v-for="reason in advice.reasons" :key="reason">{{ reason }}</p>
          <p v-for="warning in advice.warnings" :key="warning" class="warning">{{ warning }}</p>
          <button
            v-if="
              advice.verified && advice.mode && advice.mode !== draft.parameters.regulation.mode
            "
            type="button"
            :disabled="locked"
            @click="applyAdvice"
          >
            Выбрать: {{ regulationModeLabels[advice.mode] }}
          </button>
          <p class="hint">
            {{
              advice.verified
                ? 'Рекомендация считается по введённым данным и ничего не выбирает сама; решение и его обоснование остаются за составителем.'
                : `Не подтверждены: ${advice.unconfirmed.join('; ')}. Для них действуют значения прототипа. Подтвердите параметры по текстам ОДМ и ГОСТ Р 58350 в «Реестры» → «Нормативные параметры»; до этого способ пропуска выберите сами в поле «Регулирование Б.34».`
            }}
          </p>
        </section>
        <div v-for="code in zoneCodes" :key="code">
          <h3>Зона {{ templateLabel(code) }}</h3>
          <button
            v-if="!draft.parameters.workZones[code]"
            type="button"
            :disabled="locked"
            @click="addZone(code)"
          >
            Добавить размеры {{ templateLabel(code) }}
          </button>
          <div v-else class="fields compact">
            <label
              >Отвод, м
              <input
                v-model="draft.parameters.workZones[code]!.taperMetres"
                type="text"
                inputmode="decimal"
            /></label>
            <label
              >Буфер, м
              <input
                v-model="draft.parameters.workZones[code]!.bufferMetres"
                type="text"
                inputmode="decimal"
            /></label>
            <label
              >Фронт работ, м
              <input
                v-model="draft.parameters.workZones[code]!.workMetres"
                @input="draft.parameters.frontFromPu66 = false"
                type="text"
                inputmode="decimal"
            /></label>
            <label
              >Подпись отвода
              <input v-model="draft.parameters.workZones[code]!.labels.taper" type="text"
            /></label>
            <label
              >Подпись буфера
              <input v-model="draft.parameters.workZones[code]!.labels.buffer" type="text"
            /></label>
            <label
              >Подпись фронта
              <input v-model="draft.parameters.workZones[code]!.labels.work" type="text"
            /></label>
          </div>
        </div>
      </fieldset>

      <fieldset v-if="!mode || mode === 'title'" :disabled="locked">
        <legend>Реквизиты листа</legend>
        <h3>Разработчик</h3>
        <div class="fields">
          <label
            >Организация
            <input
              v-model="draft.titleBlock.developer.organization"
              data-field="titleBlock.developer.organization"
              type="text"
          /></label>
          <label
            >Должность
            <input
              v-model="draft.titleBlock.developer.position"
              data-field="titleBlock.developer.position"
              type="text"
          /></label>
          <label
            >ФИО
            <input
              v-model="draft.titleBlock.developer.name"
              data-field="titleBlock.developer.name"
              type="text"
          /></label>
          <label
            >Дата
            <input
              v-model="draft.titleBlock.developer.date"
              data-field="titleBlock.developer.date"
              type="text"
          /></label>
        </div>
        <h3>Работы</h3>
        <div class="fields">
          <label
            >Организация
            <input
              v-model="draft.titleBlock.work.organization"
              data-field="titleBlock.work.organization"
              type="text"
          /></label>
          <label
            >Описание
            <input
              v-model="draft.titleBlock.work.description"
              data-field="titleBlock.work.description"
              type="text"
          /></label>
          <label
            >Период
            <input
              v-model="draft.titleBlock.work.period"
              data-field="titleBlock.work.period"
              type="text"
          /></label>
        </div>
        <h3>Ответственные за проведение работ</h3>
        <p class="hint">
          Первый ответственный обязателен, второй — по необходимости. Телефон вводится цифрами,
          маска {{ PHONE_PLACEHOLDER }} подставляется сама.
        </p>
        <div
          v-for="(person, index) in draft.titleBlock.responsible"
          :key="index"
          class="fields responsible"
          role="group"
          :aria-label="`Ответственный ${index + 1}`"
        >
          <label
            >Должность ответственного {{ index + 1 }}
            <input
              v-model="person.position"
              :data-field="`titleBlock.responsible.${index}.position`"
              type="text"
          /></label>
          <label
            >ФИО ответственного {{ index + 1 }}
            <input
              v-model="person.name"
              :data-field="`titleBlock.responsible.${index}.name`"
              type="text"
          /></label>
          <label
            >Телефон ответственного {{ index + 1 }}
            <input
              :value="person.phone"
              :data-field="`titleBlock.responsible.${index}.phone`"
              type="tel"
              inputmode="tel"
              autocomplete="off"
              :placeholder="PHONE_PLACEHOLDER"
              maxlength="18"
              @input="onPhoneInput(index, $event)"
          /></label>
        </div>
        <div class="actions">
          <button
            v-if="draft.titleBlock.responsible.length < 2"
            type="button"
            @click="addResponsible"
          >
            Добавить второго ответственного
          </button>
          <button v-else type="button" @click="removeResponsible">
            Убрать второго ответственного
          </button>
        </div>
        <h3>Утверждает владелец автомобильной дороги</h3>
        <div class="fields">
          <label
            >Должность
            <input
              v-model="draft.titleBlock.approver.position"
              data-field="titleBlock.approver.position"
              type="text"
          /></label>
          <label
            >Владелец дороги / организация
            <input
              v-model="draft.titleBlock.approver.organization"
              data-field="titleBlock.approver.organization"
              type="text"
          /></label>
          <label
            >ФИО
            <input
              v-model="draft.titleBlock.approver.name"
              data-field="titleBlock.approver.name"
              type="text"
          /></label>
        </div>
        <h3>Согласовывает Госавтоинспекция</h3>
        <div class="fields">
          <label
            >Должность и подразделение
            <input
              v-model="draft.titleBlock.agreement.position"
              data-field="titleBlock.agreement.position"
              type="text"
          /></label>
          <label
            >ФИО
            <input
              v-model="draft.titleBlock.agreement.name"
              data-field="titleBlock.agreement.name"
              type="text"
          /></label>
          <label
            >Год
            <input
              v-model="draft.titleBlock.agreement.year"
              data-field="titleBlock.agreement.year"
              type="text"
          /></label>
        </div>
      </fieldset>

      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-if="status" class="hint" role="status">{{ status }}</p>
      <div class="actions">
        <button type="submit" class="primary" :disabled="locked || !dirty">Применить правки</button>
        <button type="button" :disabled="locked || !dirty" @click="discard">Отменить ввод</button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.normative {
  margin: 0.6rem 0;
}
.normative button {
  margin-bottom: 0.3rem;
}
.warning {
  color: #8a3b12;
}
.advice,
.decision-evidence {
  margin: 0.8rem 0 1rem;
  padding: 0.7rem 0.9rem;
  border-left: 4px solid #2f7d5b;
  background: #eef6f1;
}
.advice h3,
.decision-evidence h3 {
  margin: 0 0 0.4rem;
}
.advice p,
.decision-evidence p {
  margin: 0.3rem 0;
  line-height: 1.45;
}
.advice.unverified {
  border-left-color: #8a7a2f;
  background: #f7f4e8;
}
.advice .warning {
  color: #8a3b12;
}
h2 {
  margin: 0 0 1rem;
  font-size: 1.4rem;
}
h3 {
  margin: 1.2rem 0 0.5rem;
  font-size: 1rem;
}
.hint {
  color: #526273;
  font-size: 0.9rem;
  line-height: 1.5;
}
.error {
  color: #a22030;
  font-weight: 600;
}
fieldset {
  margin: 1.5rem 0;
  padding: 1rem;
  border: 1px solid #d8e1eb;
  border-radius: 0.45rem;
}
legend {
  padding: 0 0.4rem;
  font-weight: 700;
}
.fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
  gap: 0.8rem 1rem;
}
.fields.responsible {
  margin-bottom: 0.8rem;
}
.fields.compact {
  grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
}
label {
  display: block;
  font-size: 0.9rem;
  font-weight: 600;
}
/*
 * Поля с пометкой норматива: подпись, поле и пометка — три строки общей сетки, поэтому поля
 * стоят на одной линии при подписях разной длины и при пометках разной высоты.
 */
.fields.with-marks > label {
  display: grid;
  grid-row: span 3;
  grid-template-rows: subgrid;
  grid-template-columns: minmax(0, 1fr);
  justify-content: stretch;
  row-gap: 0.3rem;
}
.fields.with-marks > label > .caption {
  align-self: end;
}
.fields.pairs {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
@media (max-width: 36rem) {
  .fields.pairs {
    grid-template-columns: minmax(0, 1fr);
  }
}
/* Подпись сверху, поле снизу: поля одной строки стоят на общей линии при подписях разной длины. */
.fields > label {
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: 0.3rem;
  min-width: 0;
}
input[type='text'],
input[type='tel'],
select {
  display: block;
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  margin-top: 0.3rem;
  padding: 0.55rem;
  border: 1px solid #93a5b8;
  border-radius: 0.35rem;
  background: #fff;
  font: inherit;
  font-weight: 400;
}
.fields > label > input[type='text'],
.fields > label > input[type='tel'],
.fields > label > select {
  margin-top: 0;
}
.checkbox {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 1rem 0;
}
.checks {
  display: flex;
  flex-wrap: wrap;
  gap: 0 1.5rem;
}
.checks .checkbox {
  margin: 0.8rem 0;
}
.actions {
  display: flex;
  gap: 0.7rem;
  flex-wrap: wrap;
}
button {
  padding: 0.7rem 1rem;
  border: 1px solid #185ca5;
  border-radius: 0.45rem;
  background: #fff;
  color: #185ca5;
  cursor: pointer;
  font: inherit;
  font-weight: 600;
}
button.primary {
  background: #185ca5;
  color: #fff;
}
button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
button:not(:disabled):focus-visible {
  outline: 2px solid #185ca5;
  outline-offset: 2px;
}
</style>
