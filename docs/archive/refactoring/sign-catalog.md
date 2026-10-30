# Каталог знаков: партии, активный набор и PNG (#135)

> **Исторический материал.** Перенесён 29.10.2026 из `docs/refactoring/sign-catalog.md`; исходный срез — [4f3acd6](https://github.com/hhypest/editor-of-tod/blob/4f3acd687bdf09c8063a03cb8e52f46d6f751885/docs/refactoring/sign-catalog.md), последнее изменение исходника — 2026-10-26 758f18f. Даты, форматы, результаты и «следующие шаги» в тексте относятся к описываемому этапу. [Текущее описание](../../engineering/server-and-storage.md) · [Текущая очередь](../../../ROADMAP.md) · [Каталог](../../catalog.md).

`server/signs/catalog-repository.ts` владеет plan/import/latest/list/getMetadata/getPng и SQL партий, текущих изображений, активного набора и истории редакций. RegistryStore делегирует шесть методов; прежние SignCatalogSource/SignCatalogPlan экспортируются из фасада для совместимости. Владелец исторических ссылок SignCatalogDocumentReferences остаётся частью модуля знаков и обслуживает документы/удаление.

## План и импорт

План сохраняет входной порядок кодов, ошибку повтора, added/updated/unchanged/retired/relabelled и массивы кодов. Same-source по-прежнему сравнивает documentCode/edition/pdfSha256; смена только ZIP при прежних PNG и источнике не создаёт новую запись. Default source, nullable documentId и прежние прямые входы сохраняются без новой валидации.

Import вычисляет план до BEGIN, no-op возвращает его без записи, часов или новой партии. Изменения выполняются под прежней BEGIN IMMEDIATE: batch → current/history/active → retirement → commit. Часы вызываются для партии и отдельно для каждой записанной/исключённой редакции; receiver фасада сохраняется. Ошибка записи/часов/позднего retirement откатывает все четыре области. Вложенный BEGIN не откатывает транзакцию вызывающего.

Relabel одинаковых действующих PNG добавляет партию и меняет ссылки active, но не переписывает старую редакцию/её batch. Исключение записывает inactive-редакцию, повторное исключение не создаёт лишнюю; возврат создаёт новую active-редакцию даже при тех же PNG. Пустой пакет исключает действующие знаки и сохраняет прежние signCount=0/zipSha256=''; повтор пустого пакета — no-op.

## Чтение и изображения

Latest выбирается по batch id DESC. List показывает активные знаки в прежнем порядке и с прежними query/limit/экранированием LIKE. Текущий PNG читается через active, historical — только из выбранной active-редакции; inactive-редакция не подменяется текущей. Metadata извлекает размеры именно plain PNG по прежним signature/IHDR/length/nonzero guards, а не из текущих width/height. Байты, pinned revisions и HTTP ETag не меняются.

Repository получает одно существующее соединение и часы; не открывает/закрывает SQLite, не мигрирует и не создаёт backup. Все шесть тел методов и SQL/проекции совпадают после переименования внутренних вызовов. Новые форматы и алгоритмы не вводятся.

## ZIP/PDF и границы

Сценарии sign-web-import/sign-pdf-import получают SignImportCommands вместо RegistryStore. Preview и получение изображений ограничены операциями чтения; PDF image/extraction требуют только document/PDF. Все тела функций и конструкторов, включая decode/лимиты, выбор источника, извлечение/нумерацию/жёлтые варианты, fingerprints, no-op и повторный план после backup, сохранены. Полная fingerprint-проверка остаётся до синхронного import; скрытого усиления этой границы нет.

Два [контракта фасада](../../../server/__tests__/sign-catalog-contracts.test.ts) прошли до переноса: часы/план/no-op/relabel/retire/reactivate и rollback позднего retirement. Десять [прямых проверок](../../../server/__tests__/sign-catalog-repository.test.ts) без RegistryStore фиксируют read-only/no init/поиск, pinned/malformed PNG metadata, defaults/пустой пакет/историю, rollback записи/исключения/часов, второе соединение, reopen/FK/historical references и узкие ZIP/PDF сценарии с программно созданными изображениями/PDF. Старые API/cache/PDF/import/frozen-format/E2E сохраняются.

JSON v10/SQLite v13, поля #110, нормативные правила и выпускной лист сохраняются. Тестовые данные и изображения вымышлены; новых зависимостей нет.

Следующий этап #135 — ручной composition root, общие HTTP-компоненты и группы маршрутов, затем bootstrap/shutdown и удаление фасада. А4 ещё открыт; Pinia первой после А4, новые функции после всей [технической очереди](../../../ROADMAP.md).
