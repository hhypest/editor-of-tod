# Общая UI-проекция сессии в Pinia (#191)

> **Исторический материал.** Перенесён 29.10.2026 из `docs/refactoring/project-session-ui-store.md`; исходный срез — [4f3acd6](https://github.com/hhypest/editor-of-tod/blob/4f3acd687bdf09c8063a03cb8e52f46d6f751885/docs/refactoring/project-session-ui-store.md), последнее изменение исходника — 2026-10-27 6b0235c. Даты, форматы, результаты и «следующие шаги» в тексте относятся к описываемому этапу. [Текущее описание](../../engineering/state-and-recovery.md) · [Текущая очередь](../../../ROADMAP.md) · [Каталог](../../catalog.md).

Четвёртый владелец после [документа, истории и восстановимого ввода](project-document-store.md), включённых в main через #230 (fb185cf). Основа — [ADR-0011](../../adr/0011-pinia-ui-state.md) и [план перехода](pinia-state-plan.md). Это отдельный шаг перед навигацией.

## Данные и границы

`src/stores/project-session-ui.ts` предоставляет десять прежних реактивных полей на Vue app:

- `localBusy`, `localError`, `localNotice`, `projectsRefreshKey`;
- `templateMessage`, `templateError`, `signPinMessage`;
- `recoveryCopies`, `recoveryStatus`, `activeRecoveryId`.

Сохраняются прежние `ref`, включая глубокое представление списка recovery. Store явно возвращает все поля и не содержит команд, watchers, HTTP, repository, таймеров или browser lifecycle. Получение store не создаёт recovery id; начальный id назначает единственный recovery-адаптер при сборке корневой сессии. Повторное чтение store не сбрасывает сообщения, busy или существующую recovery.

`useProjectSession` получает один `storeToRefs` и явно передаёт его узким ref-портам `useTemplateActions` и `useProjectRecovery`. Persistence, file и recovery actions продолжают работать с теми же refs через прежние интерфейсы. Совместимые вызовы template/recovery adapters без явного порта выбирают store текущего app во время создания адаптера; уже созданные команды после await не ищут новую active Pinia.

Вторая сессия для чтения данных не создаётся. `RecoverySession`, версии, очередь записи, cursor/generation, выполняющийся heartbeat, debounce 800 мс, интервал heartbeat, listeners и start/stop остаются в прежних адаптерах/корне. Дочерний читатель получает только store. Общего `$reset` и сериализации store нет. `hasUnsavedWork` остаётся прежним вычислением корня над документом и dirty flags.

## Совместимость

AST-сверка подтвердила сохранение 21 тела именованных команд: 12 в recovery adapter, 3 в template adapter и 6 в корневой сессии. Поздние guards сохраняются. Начало другой сессии по-прежнему меняет id/status, отменяет debounce и освобождает прежнюю копию, сохраняя сам документ и неприменённый ввод до соответствующих явных действий. Очистка сообщений при open/save/undo выполняется теми же командами. Публичный `ProjectSession` сохраняет 44 ключа, совместимые aliases и типы refs.

JSON v10, SQLite v13, нормативные правила, поля #110, импорт, PNG/печать и схема зависимостей core не меняются. Зависимости и lockfile не меняются; действующая проверка разрешительных лицензий остаётся в production build. Рабочих данных в изменении нет.

## Проверки

До runtime-переноса добавлены два контракта `project-recovery.test.ts`: создание адаптера без запросов/таймеров и сохранение данных при смене recovery id. Вместе с прежними session/persistence/recovery/template delivery прошли **56 сценариев** на исходных composables.

После переноса добавлены пять проверок:

- чтение store без HTTP/listeners/таймеров и без нового recovery id;
- общее состояние десяти полей для двух читателей и изоляция разных app после await/смены active Pinia;
- явные recovery refs: новый читатель сохраняет pending, прежняя команда записывает в тот же store после смены active Pinia;
- явные template refs: поздний результат PNG попадает исходному владельцу;
- настоящий Vue lifecycle корневой сессии: два читателя видят busy/result/refresh сохранения, не создают repository/requests/listeners/таймеры; unmount снимает пять window listeners и останавливает таймеры.

Прежние save/restore cursor guards, revision conflict, recovery wake/claim/save, два окна и шаблоны проверяются существующими application/API/session/E2E сценариями. Локально полный `npm run check` прошёл: **132 файла / 1024 теста**, Node API/CLI/desktop, production build и лицензии. Chromium — **56/56**, без повторов и изменения E2E-настроек. Результаты CI фиксируются для фактического коммита в PR. #191 остаётся открытой: далее навигация/обоснование оставшегося setup-refresh состояния, затем итоговый main и Windows exe; прежняя exe А4 не считается проверкой новых stores.
