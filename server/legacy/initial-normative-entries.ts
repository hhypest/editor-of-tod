import type { NormativeDraft } from '../../src/domain/registry.ts'

export const initialNormativeEntries: readonly NormativeDraft[] = [
  {
    id: 'odm-218-6-019-2016-b33',
    documentCode: 'ОДМ 218.6.019-2016',
    edition: '2016',
    clause: 'Приложение Б, рисунок Б.33, с. 100',
    description:
      'Пример схемы для двухполосной дороги при краткосрочных работах; подпись говорит о зоне более 30 м, рисунок содержит обозначение min 30.',
    application:
      'Решение проекта по практике технических специалистов: фронт работ более 30 м (параметр «Наибольший фронт работ для схемы Б.34»). Подписи и размерные обозначения рисунков ОДМ расходятся, поэтому порог настраивается в реестре нормативных параметров.',
    sourceUrl:
      'https://rosavtodor.gov.ru/about/upravlenie-fda/upravlenie-nauchno-tekhnicheskikh-issledovaniy--i-informatsionnykh-tekhnologiy/tekhnicheskoe-regulirovanie/otraslevye-dorozhnye-metodicheskie-dokumenty/14520',
    reviewStatus: 'needs-review',
    checkedAt: '',
    reviewer: '',
  },
  {
    id: 'odm-218-6-019-2016-b34',
    documentCode: 'ОДМ 218.6.019-2016',
    edition: '2016',
    clause: 'Приложение Б, рисунок Б.34, с. 101',
    description:
      'Пример схемы для двухполосной дороги при краткосрочных работах; подпись говорит о зоне менее 30 м, рисунок содержит обозначение max 30.',
    application:
      'Решение проекта по практике технических специалистов: фронт работ до 30 м включительно (параметр «Наибольший фронт работ для схемы Б.34»). Условия регулирования движения по интенсивности и видимости следует сверять отдельно.',
    sourceUrl:
      'https://rosavtodor.gov.ru/about/upravlenie-fda/upravlenie-nauchno-tekhnicheskikh-issledovaniy--i-informatsionnykh-tekhnologiy/tekhnicheskoe-regulirovanie/otraslevye-dorozhnye-metodicheskie-dokumenty/14520',
    reviewStatus: 'needs-review',
    checkedAt: '',
    reviewer: '',
  },
  {
    id: 'gost-r-52289-2019',
    documentCode: 'ГОСТ Р 52289-2019',
    edition: '2019; изменения № 1 и № 2 подлежат сверке',
    clause: 'Раздел 5, в том числе 5.1.19 и 5.2.27',
    description:
      'Правила применения технических средств организации дорожного движения; конкретные параметры здесь пока не внесены.',
    application: 'Проверить действующую редакцию и точные пункты перед автоматизацией.',
    sourceUrl: 'https://protect.gost.ru/gost/details/94160176-3252-4e7d-8534-2d172e6aa0de',
    reviewStatus: 'needs-review',
    checkedAt: '',
    reviewer: '',
  },
  {
    id: 'gost-r-52290-2024',
    documentCode: 'ГОСТ Р 52290-2024',
    edition: '2024',
    clause: 'Группы и технические требования к знакам',
    description:
      'Источник для будущего каталога знаков; изображения и полный текст в приложение не включены.',
    application: 'Проверить применимые пункты и права на графику перед публикацией каталога.',
    sourceUrl: 'https://protect.gost.ru/gost/details/39b75217-29bd-492b-94f4-c0dccb72b299',
    reviewStatus: 'needs-review',
    checkedAt: '',
    reviewer: '',
  },
]
