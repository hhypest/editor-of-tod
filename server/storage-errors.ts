/** Shared storage errors; the stable facade re-exports these same constructors. */
export class RevisionConflict extends Error {
  constructor() {
    super('Запись изменилась после открытия. Обновите реестр и повторите правку.')
  }
}

export class ProjectTooLarge extends Error {
  constructor() {
    super('Черновик больше 32 МБ. Скачайте файл проекта, чтобы сохранить его отдельно.')
  }
}

export class RecoveryOwned extends Error {
  constructor() {
    super('Копия открыта в другом окне. Закройте его или дождитесь освобождения копии.')
  }
}
