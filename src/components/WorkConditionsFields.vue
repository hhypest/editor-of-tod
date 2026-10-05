<script setup lang="ts">
import type { SchemeDetailsDraft } from '../domain/edit-details'
const model = defineModel<SchemeDetailsDraft['parameters']['workConditions']>({ required: true })
</script>
<template>
  <fieldset>
    <legend>Срок и условия работ</legend>
    <div class="fields">
      <label
        >Продолжительность работ
        <select v-model="model.kind" data-field="parameters.workConditions.kind">
          <option value="unknown">Не определена</option>
          <option value="short">Краткосрочные (не более одного дня)</option>
          <option value="long">Долгосрочные (требуется другой профиль)</option>
        </select>
      </label>
      <label
        >Длительность, ч
        <input
          v-model="model.durationHours"
          data-field="parameters.workConditions.durationHours"
          type="text"
          inputmode="decimal"
        />
      </label>
      <label
        >Время суток
        <select v-model="model.daylight" data-field="parameters.workConditions.daylight">
          <option value="unknown">Не определено</option>
          <option value="day">Все работы в светлое время</option>
          <option value="night">Есть работы в тёмное время</option>
        </select>
      </label>
      <label
        >Участок между первым и последним устройствами, м
        <input
          v-model="model.sectionMetres"
          data-field="parameters.workConditions.sectionMetres"
          type="text"
          inputmode="decimal"
        />
      </label>
    </div>
    <p>
      Укажите измеренные границы устройств. Пока поле пустое, используется предварительная сумма
      отгона, буфера и фронта (для Б.33 — два отгона). Для выбора Б.33/Б.34 используется только
      фронт работ.
    </p>
    <label class="checkbox"
      ><input
        v-model="model.regulatorsPresent"
        data-field="parameters.workConditions.regulatorsPresent"
        type="checkbox"
      />
      Постоянное присутствие регулировщиков обеспечено на всё время работ
    </label>
    <p>
      Замена светофора — ОДМ, п. 6.4.3 и применимые сноски таблицы Д.1 ГОСТ Р 58350. Для одного
      регулировщика дополнительно нужны дневные работы и условия п. 13.7.5.
    </p>
  </fieldset>
</template>
<style scoped>
.fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 12px;
}
label {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.checkbox {
  flex-direction: row;
  align-items: center;
}
p {
  font-size: 0.9rem;
}
</style>
