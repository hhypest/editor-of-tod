# Карта общего UI-состояния и план перехода на Pinia (#191)

Исходная карта сверена с `main` `8fe864e0d4aa3d8dffa93cf5fea0cc87fa4c9bc5` от 26.10.2026. [ADR-0011](../adr/0011-pinia-ui-state.md) · [#191](https://github.com/hhypest/editor-of-tod/issues/191) · [ROADMAP](../../ROADMAP.md).

## А4 завершён; первый исполняемый шаг

А4 принят владельцем 27.10.2026, #135 закрыта. #226 и подготовительный #227 включены в main; новый [ручной Windows exe 40452642214](https://github.com/hhypest/editor-of-tod/actions/runs/40452642214) на 7d2ab75 успешен, включая 56/56 E2E; комплект доступен. [Полная фиксация](server-god-object-plan.md#фиксация-завершения-а4--27102026). Историческая ссылка №39 не блокирует дальнейшую работу.

Подключены Pinia **4.1.0**, обязательный peer @vue/devtools-api **8.2.1** и транзитивный nostics **1.3.0** (MIT; версии и integrity в lockfile). Vue/TypeScript и прежние версии других пакетов не менялись. Один createPinia устанавливается в main до mount. `src/stores/normative-rules.ts` владеет состоянием параметров и выполняющейся загрузкой; `useNormativeRules` сохраняет пять прежних ключей через storeToRefs и action. Дополнительных refs в фасаде нет. Расчёт rulesFrom и HTTP listParameterStates остаются на прежних границах.

Исходная карта ниже показывает владельцев перед переносом. Первый владелец (нормативные параметры) переведён; ПУ-66, документ/история/ввод, recovery и навигация пока не переводились. #191 остаётся открытой.

## Владельцы и границы

Имена будущих stores обозначают ответственность, а не готовые модули. Поля и публичные ключи сверяются перед каждым переносом; исходный [ProjectSession](vue-session-plan.md) сохраняется.

| Данные                                                                           | Текущий владелец и потребители                                                          | Планируемый владелец                                     | Что остаётся за его границей                                                                                               |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Состояния нормативных параметров, производные rules, loading/error               | module-level refs `useNormativeRules`; корень, сессия, формы, checklist и лист          | `normativeRules` store, совместимый `useNormativeRules`  | `listParameterStates` в services; вычисления `rulesFrom` в domain; один выполняющийся reload                               |
| Статусы карточек по ключу, version/invalidation, loading/unavailable             | module-level refs/cache `usePu66Status`; источник, checklist, лист                      | `pu66Status` store, совместимый composable               | HTTP `getPu66Status`; одна загрузка на ключ и повтор при invalidation во время запроса; focus/watch lifecycle у компонента |
| Открытый импортированный документ, имя файла, localRevision, modified, selection | `useProjectDocument`, созданный один раз сессией                                        | `projectDocument` store с прежними refs                  | open/commit/undo через адаптеры; domain Scheme и правила снятия PNG pins                                                   |
| История, dirty flags, pendingDetails/pendingPlacement, recoverySeed              | `useProjectHistory` и `useEditorDraftState` внутри той же сессии; редакторы через props | те же данные в едином `projectDocument` store            | локальный ввод формы, предметные `recordEdit`/`undoEdit`/`redoEdit`; нельзя дублировать историю                            |
| localBusy/error/notice, projectsRefreshKey, template/sign messages               | `useProjectSession`, persistence и template adapters                                    | данные того же session-facing store, без новых workflows | курсоры/locks, ответы API, template и pinning commands; прежние guards при поздних ответах                                 |
| recoveryCopies/status/activeRecoveryId                                           | `useProjectRecovery` поверх одной `RecoverySession`                                     | UI-проекция того же store на отдельном шаге              | repository, debounce, heartbeat, generation, очередь и версии принадлежат прежним адаптерам; один start/stop               |
| activeView/projectTab/registryTab, visited, helpSection/openKey, findingNotice   | `useEditorNavigation` у корня                                                           | `editorNavigation` store с совместимым composable        | DOM focus/scroll/nextTick и mounted hooks; выбор стартовой вкладки с прежним guard                                         |
| setup status/open/error, signCatalogVersion/pu66CatalogVersion                   | `App.vue`, связи setup и обновлений реестров                                            | корень до отдельного обоснованного переноса в UI store   | `sessionStorage` прежнего deferred setup, startup/request guards; не переносить весь мастер в store                        |
| Файлы импорта, preview/plans, поля подтверждений, раскрытие разделов, формы      | компоненты SetupWorkspace, редакторы и реестры                                          | прежние локальные владельцы                              | программные файлы/PDF и диалоги не становятся общим состоянием                                                             |

## Последовательность совместимых PR

1. **Подготовка — выполнено в #227.** Карта владельцев, контракт нормативного общего состояния на исходном composable, фиксация проверенного main и оставшегося барьера А4. Никаких новых зависимостей и runtime-изменений.
2. **Подключение и нормативные параметры — первый исполняемый шаг.** Один `createPinia` в main, store вместо module-level refs, прежний `useNormativeRules` как адаптер `storeToRefs`/actions. Выбрать совместимую фактическую версию, проверить lockfile и лицензии сборки. Прежде изменения снять дополнительные контракты при обнаружении пробела. Сохранить dedup reload и прежнюю политику ошибки; два потребителя используют один store, два app — разные stores. Не дублировать states в фасаде. Добавить запрет core → `pinia`/`src/stores` и негативную проверку; общее усиление анализатора остаётся в #184.
3. **Кэш статусов ПУ-66.** До переноса проверить нескольких потребителей/разные ключи, failure/retry, смену ключа, invalidation во время запроса и снятие focus/watch подписок. Вынести только данные/запросы общего владельца, сохранить блокировку проверки выпуска при loading/unavailable и прежние снимки проектов.
4. **Документ, история и ввод.** Сначала фиксировать совместное чтение/правку двумя потребителями. Передать store refs существующим document/history/draft adapters. Не создавать сессию внутри store. Сохранить `clearDirty` отдельно от `clearPending`, согласованный commit и историю PNG pins. Прежние props/44 ключа фасада работают до перевода потребителей.
5. **Оставшаяся session-facing UI-проекция.** Перевести busy/notice/refresh и recovery refs; `useProjectSession`, persistence/recovery/file/template adapters сохраняют существующие workflows. Проверить единичность start/stop, heartbeat/очереди, guard позднего save/restore/pin и wake/claim/save, а также работу второго окна. Нельзя превращать `$reset` store в потерю несохранённой recovery.
6. **Навигация и завершение.** Перевести общее состояние навигации без её DOM lifecycle и циклов session → navigation. Для setup/refresh обосновать конкретное разделение; локальные формы оставить локальными. Удалить заменённые singleton refs; совместимые composables можно сохранить как узкие ref-based adapters. Сверить итоговый main, полный E2E, Windows exe и остатки #191; далее #184 → #137 → #138 → итоговая регрессия.

Каждый PR имеет одну границу и точку отката без миграций данных. Не отмечать всю #191 готовой после подключения зависимости или первого store.

## Предварительные и приёмочные проверки

Исходные [6 контрактов useNormativeRules](../../src/composables/__tests__/useNormativeRules.test.ts) выполняются до изменения runtime:

- чтение двумя потребителями не запускает HTTP, данные/правила/loading/error общие;
- параллельные reload дают один запрос и один общий результат;
- отказ чтения сохраняет прежний ответ и сообщает ошибку всем потребителям;
- успешный повтор очищает ошибку; до его завершения ошибка сохраняется;
- отказ не-Error получает прежнее сообщение и завершает всех ожидающих;
- следующий ответ заменяет список целиком, пустой ответ возвращает prototype rules.

Сохранение прежних данных при ошибке — характеристика существующего поведения, не новое нормативное решение. Изменение этой политики требует отдельного поведенческого PR. Шесть исходных контрактов сохранены; добавлены две проверки Pinia: два app изолируют данные/ошибки/выполняющиеся запросы даже после смены active Pinia, два потребителя одного app разделяют одну загрузку и сохраняют пять публичных ключей. Исходный singleton изоляции не обеспечивал.

Уже существующие [контракты Vue-сессии](../../src/composables/__tests__/useProjectSession.test.ts), [application recovery](../../src/application/__tests__/recovery-session.test.ts), revision workflows, navigation tests, API/frozen formats и полный E2E сохраняются. Дополнения нужны в месте переноса конкретного владельца; не заменять настоящие команды заглушками store actions при проверках сохранности.

На каждом PR: `npm run check` и полный браузерный E2E с прежними ожиданиями/настройками повторов. Фиксировать head/tree и фактические результаты; недоступный browser/Windows прогон обозначать как непроверенный, не как успешный. Для завершения #191 — доступная Windows exe, проверка комплектности/хешей и фиксация результата; автоматический runner не удостоверяет производительность целевого ПК.
