# Маршруты проектов и восстановления (#135)

`server/http/routes/projects.ts` и `recovery.ts` получают ProjectRouteStorage/RecoveryRouteStorage: только шесть операций проектов и семь операций восстановления. Они не импортируют RegistryStore/DatabaseSync, не открывают базу и не собирают транзакции. Контракты принимают существующие ProjectRepository/RecoveryRepository напрямую.

## Распознавание и транспорт

RouteHandler получает IncomingMessage, ServerResponse и уже разобранный URL, возвращает true после ответа или false без чтения тела, отправки заголовков и вызовов хранилища. Ошибки проходят в общий error mapper. Host/Origin и регистрация диагностики finish остаются в оболочке до вызова групп. Неподдерживаемый метод или неполный путь сохраняет прежний общий 404, нового 405/OPTIONS/CORS поведения нет.

Шесть project branches: list, revision, revisions, get, PUT и restore. Пять recovery branches: list, get, claim/heartbeat/release, PUT и DELETE. Прежние regexp и URL → body schema → identity/storage order сохранены. OwnerId читается из уже существующего URL вместо повторного построения того же URL. GET recovery всегда передаёт access-объект, включая ownerId=undefined, поэтому анонимное чтение активной чужой копии остаётся запрещённым.

PUT проекта сохраняет 32 МиБ + 64 КиБ лимит транспортного тела, schema/ID, expectedRevision и прежнее сохранение. Restore возвращает новую редакцию; старые снимки не меняются. PUT recovery сохраняет тот же лимит, неизвестный Scheme во внешнем transfer и одну атомарную save-команду: owner/version/source/валидация Scheme остаются внутри прежней транзакции repository. Маршрут не добавляет assert/resolve и не меняет порядок отказов. Receipt по-прежнему содержит только version/updatedAt и SHA исходного JSON для legacy; native-проект SHA не получает. Claim меняет версию, heartbeat/release и DELETE сохраняют свои прежние контракты.

## Совместимый переход

`createRegistryServer` сохраняет публичную сигнатуру и создаёт два узких объекта-адаптера с callback к прежним методам фасада. В группы передаются только эти операции, без самого фасада или соединения. Callback вызывают методы на прежнем объекте, сохраняя receiver часов. RegistryStore и composition root в этом PR не меняются; forwarding methods ещё используются старым bootstrap и тестами.

Группы вызываются после security до оставшейся цепочки. Их точные пути не пересекаются с другими областями; 35 оставшихся ветвей и fallback сохранены. После перевода всех групп bootstrap свяжет их с composition root напрямую и удалит временные callback/фасад. Этот PR не объявляет bootstrap или #135 завершёнными.

## Проверки

Три [предварительных API-контракта](../../server/__tests__/project-recovery-api-contracts.test.ts) прошли на исходном index: порядок URL/body/identity и history lookup, явный read-access/owner query/обязательный owner DELETE, прежние 404 без побочных действий. Семь [прямых проверок групп](../../server/__tests__/project-recovery-routes.test.ts) без RegistryStore используют существующие repositories на одной SQLite и отдельные простые ports: no-op/conflict/restore/history, owner/claim/heartbeat/release/delete и source receipt, тела больше 64 КиБ/общий source/native receipt, оба SQL rollback, untouched fallback и одна save-команда с неизвестным Scheme.

AST-сверка сохраняет все 11 перенесённых ветвей после замены зависимостей, упаковки аргументов команды и использования уже разобранного URL; 35 остальных ветвей и fallback не меняются. Старые API, recovery ownership/source/конкуренция, frozen formats и полный E2E остаются обязательными. Тестовые данные вымышленные, новых зависимостей нет.

Далее ПУ-66, signs/documents, system/diagnostics/legacy, тонкий bootstrap/shutdown и удаление фасада. JSON v10/SQLite v13, нормативные правила, лист и поля #110 сохраняются. #135/А4 открыты; Pinia первой после А4. Переработка интерфейса остаётся для 0.4.0, настольные оболочки отложены.
