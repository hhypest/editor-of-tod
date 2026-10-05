/** Sources for a preliminary drawing profile, not a statement that a project complies. */
export const draftTemplateProfile = {
  id: 'draft-2',
  source: 'ОДМ 218.6.019-2016',
  clauses: {
    figures: 'Приложение Б, рисунки Б.33 и Б.34 (стр. 100–101)',
    roadworks: '9.1.2.2',
    priority: '6.4.4, 9.1.3.1; ГОСТ Р 58350-2019, п. 6.1.3, таблицы Д.1 и И.1',
    regulators: '13.7.3–13.7.5, таблица 5',
    settlement: 'ГОСТ Р 52289-2019, пп. 5.2.2, 5.4.22 — расстояния и ступени скорости сверяются',
  },
  /**
   * Смещения стоек от начала отвода (L0) и конца зоны (E) в единицах листа 1680 × 1188.
   * Это компоновка рисунка, а не расстояния на местности: расстояния подписываются маркерами.
   */
  offsets: {
    outside: {
      regular: { before: [-520, -410, -290, -170], after: [170, 290, 410, 500] },
      priority: { before: [-600, -520, -412, -210], after: [208, 332, 452, 536] },
    },
    settlement: {
      regular: { far: -410, near: -255, afterNear: 255, afterFar: 420 },
      priority: { far: -540, near: -385, afterNear: 300, afterFar: 465 },
    },
  },
} as const
