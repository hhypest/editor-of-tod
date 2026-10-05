import { describe, expect, it } from 'vitest'
import b33 from '../../../tests/fixtures/manual-v1.json?raw'
import b34 from '../../../tests/fixtures/legacy-b34-manual.json?raw'
import { createUnlinkedScheme } from '../create-scheme'
import { applySchemeDetails, createSchemeDetailsDraft } from '../edit-details'
import { newSignDraft, savePlacement } from '../edit-placements'
import { projectDraftSheet } from '../draft-sheet'
import { importSchemeJson } from '../import'
import { linkPu66Card } from '../link-pu66'
import {
  drawableWithoutImage,
  drawSheet,
  objectsOutside,
  overlappingPosts,
  postColumns,
  signImageCode,
  SHEET_HEIGHT,
  SHEET_WIDTH,
  textWidth,
  wrapText,
  type SheetNode,
} from '../sheet-drawing'

const options = {
  signSizes: new Map([
    ['1.25', { width: 115, height: 100 }],
    ['3.24_ж', { width: 100, height: 100 }],
    ['8.2.1', { width: 200, height: 100 }],
    ['4.2.2', { width: 100, height: 100 }],
  ]),
  catalogLabel: 'Знаки: учебный каталог.',
  revisionLabel: 'Проект не сохранён.',
}

function scheme() {
  return createUnlinkedScheme({
    referenceId: 'TEST-DRAW',
    locationText: 'Учебный участок',
    directionLeft: 'на А',
    directionRight: 'на Б',
    frontMetres: '18',
    taperMetres: '10',
    bufferMetres: '10',
    speedStagesKmh: ['70', '50', '40'],
    location: 'out',
    approachSpeedKmh: '90',
    yellowTemporarySigns: true,
  })
}

function flatten(nodes: readonly SheetNode[]): SheetNode[] {
  return nodes.flatMap((node) => (node.t === 'group' ? [node, ...flatten(node.children)] : [node]))
}

function texts(nodes: readonly SheetNode[]): string[] {
  return flatten(nodes).flatMap((node) => (node.t === 'text' ? [node.text] : []))
}

function withPost(signCodes: string, x: number, distance = '{d50}') {
  const post = newSignDraft()
  if (post.kind !== 'sign-post') throw new Error('Expected sign draft')
  post.signCodes = signCodes
  post.distanceLabel = distance
  post.x = String(x)
  return post
}

describe('vector A4 sheet', () => {
  it('wraps text by words within the given width and splits over-long words', () => {
    const lines = wrapText('Организация движения и ограждение зоны дорожных работ', 200, 14)
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) expect(textWidth(line, 14)).toBeLessThanOrEqual(200)
    expect(wrapText('А'.repeat(80), 100, 14).length).toBeGreaterThan(1)
    expect(wrapText('первая\nвторая', 1000, 14)).toEqual(['первая', 'вторая'])
  })

  it('uses the archive file name of the 50 km/h speed sign and draws only simple signs itself', () => {
    const available = new Set(['3.24', '3.24_ж', '3.24_70'])
    expect(signImageCode('3.24_50_ж', available)).toBe('3.24_ж')
    expect(signImageCode('3.24_50', available)).toBe('3.24')
    expect(signImageCode('3.24_70', available)).toBe('3.24_70')
    expect(signImageCode('3.24_60_ж', available)).toBe('3.24_60_ж')
    expect(drawableWithoutImage('3.24_60_ж')).toBe(true)
    expect(drawableWithoutImage('8.1.1_150')).toBe(true)
    expect(drawableWithoutImage('1.25')).toBe(false)
  })

  it('draws the road, the axis, cones along the taper and a dimension per part of the chain', () => {
    const drawing = drawSheet(projectDraftSheet(scheme()), options)
    const nodes = flatten(drawing.nodes)
    expect(
      nodes.filter((node) => node.t === 'symbol' && node.id === 'cone').length,
    ).toBeGreaterThan(10)
    expect(nodes.filter((node) => node.t === 'line' && node.arrows)).toHaveLength(3)
    expect(texts(drawing.nodes)).toEqual(expect.arrayContaining(['← на А', 'на Б →', '18']))
    expect(texts(drawing.nodes).join(' ')).not.toContain('регулировщик')
    const draft = createSchemeDetailsDraft(scheme())
    draft.parameters.regulation.mode = 'signs'
    const signs = drawSheet(projectDraftSheet(applySchemeDetails(scheme(), draft)), options)
    expect(texts(signs.nodes).join(' ')).toContain('очерёдность — знаки 2.6, 2.7')
  })

  it('puts the signs of one post in a row by the pole, a plate under its sign, and labels codes and distance', () => {
    let project = savePlacement(scheme(), withPost('1.25, 3.24_50_ж, 8.2.1', 300))
    const draft = createSchemeDetailsDraft(project)
    draft.parameters.signDistancesMetres.d50 = '50'
    project = applySchemeDetails(project, draft)
    const drawing = drawSheet(projectDraftSheet(project), options)
    const post = drawing.nodes.find((node) => node.t === 'group' && node.objectId)
    if (!post || post.t !== 'group') throw new Error('Post group expected')
    const signs = post.children.filter((node) => node.t === 'sign')
    expect(signs.map((node) => node.code)).toEqual(['1.25', '3.24_ж', '8.2.1'])
    const [warning, speed, plate] = signs as [(typeof signs)[number], ...typeof signs]
    // Знаки в ряд от стойки; табличка — под своим знаком (ГОСТ Р 52289-2019, п. 5.9.1),
    // по центру, ниже его и уже по высоте; её ширина следует пропорциям PNG.
    expect(speed!.x).toBeGreaterThan(warning.x + warning.w)
    expect(plate!.y).toBeGreaterThanOrEqual(speed!.y + speed!.h)
    expect(plate!.x + plate!.w / 2).toBeCloseTo(speed!.x + speed!.w / 2)
    expect(plate!.h).toBeLessThan(warning.h)
    expect(plate!.w / plate!.h).toBeCloseTo(2)
    // Стойка над дорогой: столбец с табличкой растёт вверх, его низ — на уровне ряда.
    expect(plate!.y + plate!.h).toBeCloseTo(warning.y + warning.h)
    expect(texts(post.children)).toEqual(['1.25', '3.24', '8.2.1', '50 м'])
    expect(drawing.signCodes).toEqual(expect.arrayContaining(['1.25', '3.24_ж', '8.2.1']))
    // Габарит стойки включает табличку: по нему проверяются перекрытия и границы листа.
    const box = drawing.objectBoxes[0]!
    expect(box.box[1] + box.box[3]).toBeGreaterThanOrEqual(plate!.y + plate!.h)
    // Подписи кодов двух табличек под одним знаком шире столбца: они входят в габарит для
    // проверки границ листа.
    const fanned = drawSheet(
      projectDraftSheet(savePlacement(scheme(), withPost('1.25, 8.1.1_300, 8.2.1', 300))),
      options,
    )
    const group = fanned.nodes.find((node) => node.t === 'group' && node.objectId)
    if (!group || group.t !== 'group') throw new Error('Post group expected')
    const codeXs = group.children.flatMap((node) =>
      node.t === 'text' && /^\d/.test(node.text) && !node.text.includes('м') ? [node.x] : [],
    )
    expect(codeXs).toHaveLength(3)
    const [extentLeft, , extentWidth] = fanned.objectBoxes[0]!.extent
    expect(extentLeft).toBeLessThanOrEqual(Math.min(...codeXs) - 14)
    expect(extentLeft + extentWidth).toBeGreaterThanOrEqual(Math.max(...codeXs) + 4)
  })

  it('assigns a plate to the previous sign, and plate 8.2.1 to the adjacent sign 1.25', () => {
    expect(postColumns(['1.25'])).toEqual([[0]])
    expect(postColumns(['3.24_70', '3.20'])).toEqual([[0], [1]])
    expect(postColumns(['1.20.2', '2.6', '8.1.1_150'])).toEqual([[0], [1, 2]])
    // Шаблон начала работ: «3.24, 8.2.1, 1.25» под дорогой и «1.25, 8.2.1, 3.24» над дорогой.
    expect(postColumns(['3.24_40', '8.2.1_38', '1.25'])).toEqual([[0], [2, 1]])
    expect(postColumns(['1.25', '8.2.1_38', '3.24_40'])).toEqual([[0, 1], [2]])
    expect(postColumns(['3.24_40', '8.2.1_500'])).toEqual([[0, 1]])
    expect(postColumns(['1.25', '8.1.1_300', '8.2.1_38'])).toEqual([[0, 1, 2]])
    expect(postColumns(['8.2.1_38', '3.24_40'])).toEqual([[1, 0]])
    expect(postColumns(['8.1.1', '8.2.1'])).toEqual([[0], [1]])
    // 8.22 — знак препятствия, а не табличка под знаком.
    expect(postColumns(['4.2.1', '8.22.1'])).toEqual([[0], [1]])
  })

  it('grows a column with a plate away from the road on both sides', () => {
    const drawn = (side: 'up' | 'down') => {
      const draft = withPost('1.25, 8.2.1', 300)
      if (draft.kind !== 'sign-post') throw new Error('Expected sign draft')
      draft.side = side
      const drawing = drawSheet(projectDraftSheet(savePlacement(scheme(), draft)), options)
      const post = drawing.nodes.find((node) => node.t === 'group' && node.objectId)
      if (!post || post.t !== 'group') throw new Error('Post group expected')
      const [sign, plate] = post.children.filter((node) => node.t === 'sign')
      const pole = post.children.find((node) => node.t === 'line' && node.sw === 2.6)
      if (!pole || pole.t !== 'line') throw new Error('Pole expected')
      return { sign: sign!, plate: plate!, axis: (pole.y1 + pole.y2) / 2 }
    }
    const below = drawn('down')
    const above = drawn('up')
    for (const { sign, plate } of [below, above]) expect(plate.y).toBeGreaterThan(sign.y + sign.h)
    // Под дорогой знак остаётся на оси стойки, табличка уходит вниз; над дорогой — табличка у
    // оси, знак поднят.
    expect(below.sign.y + below.sign.h / 2).toBeCloseTo(below.axis)
    expect(above.plate.y + above.plate.h).toBeCloseTo(above.axis + above.sign.h / 2)
    expect(above.sign.y + above.sign.h / 2).toBeLessThan(above.axis)
  })

  it('reports overlapping posts and objects outside the sheet from the layout', () => {
    let project = savePlacement(scheme(), withPost('1.25', 300))
    project = savePlacement(project, withPost('1.25', 310))
    project = savePlacement(project, withPost('1.25', SHEET_WIDTH + 50))
    const drawing = drawSheet(projectDraftSheet(project), options)
    const ids = project.placements.map((item) => item.id)
    expect(overlappingPosts(drawing)).toEqual([[ids[0], ids[1]]])
    expect(objectsOutside(drawing)).toEqual([ids[2]])
  })

  it('flags header text that does not fit instead of printing it off the sheet', () => {
    const project = scheme()
    const draft = createSchemeDetailsDraft(project)
    draft.titleBlock.work.description = 'очень длинное описание работ '.repeat(60)
    const drawing = drawSheet(projectDraftSheet(applySchemeDetails(project, draft)), options)
    expect(drawing.overflow).toContain('Наименование и сведения о работах')
    expect(drawSheet(projectDraftSheet(project), options).overflow).toEqual([])
  })

  it('lays out imported B.33 and B.34 projects inside the sheet', () => {
    for (const raw of [b33, b34]) {
      const drawing = drawSheet(projectDraftSheet(importSchemeJson(raw).scheme), options)
      for (const node of flatten(drawing.nodes)) {
        if (node.t === 'text') {
          expect(node.x).toBeGreaterThanOrEqual(0)
          expect(node.y).toBeLessThanOrEqual(SHEET_HEIGHT)
        }
      }
      expect(drawing.overflow).toEqual([])
    }
  })

  it('prints only notes that record the author decisions, not unverified sample notes', () => {
    const project = scheme()
    const draft = createSchemeDetailsDraft(project)
    draft.parameters.regulation.mode = 'two'
    draft.parameters.location = 'out'
    const all = texts(
      drawSheet(projectDraftSheet(applySchemeDetails(project, draft)), options).nodes,
    )
    const joined = all.join(' ')
    expect(joined).not.toContain('светлое время')
    expect(joined).not.toContain('УГИБДД')
    expect(joined).not.toContain('зачехлены')
    expect(joined).toContain(
      '1. Пропуск транспорта регулируют два регулировщика у начала и конца места работ (ОДМ 218.6.019-2016, п. 13.7.3).',
    )
    expect(all).toContain(
      '2. Регулировщиков устанавливать не ближе 15 м до рабочей зоны (ОДМ 218.6.019, таблица 5).',
    )
  })

  it('prints the regulator distance requirement for B.33 as well', () => {
    const project = createUnlinkedScheme({
      referenceId: 'TEST-B33',
      locationText: 'Учебный участок',
      directionLeft: 'А',
      directionRight: 'Б',
      frontMetres: '40',
      taperMetres: '10',
      bufferMetres: '15',
      speedStagesKmh: ['70', '50', '40'],
      location: 'out',
      approachSpeedKmh: '90',
      yellowTemporarySigns: false,
    })
    const all = texts(drawSheet(projectDraftSheet(project), options).nodes)
    expect(all.join(' ')).toContain(
      'Регулировщиков устанавливать не ближе 15 м до рабочей зоны (ОДМ 218.6.019, таблица 5).',
    )
  })

  it('prints the carriageway width as recorded and never derives a lane width', () => {
    const linked = linkPu66Card(scheme(), {
      referenceId: '90002:24:7',
      location: '24 км 7 пк',
      axisLabel: '24 км 7 пк',
      roadName: 'Учебная дорога Б',
      crossingWidthMetres: '6,10',
      crossingRoadLengthMetres: 40,
      revision: 1,
      updatedAt: '2026-09-28T10:00:00.000Z',
    })
    const joined = texts(drawSheet(projectDraftSheet(linked), options).nodes).join(' ')
    expect(joined).toContain('ширина проезжей части 6,10 м')
    expect(joined).not.toContain('полоса')
    // Число из карточки и расстояния печатаются с десятичной запятой.
    const decimal = linkPu66Card(scheme(), {
      referenceId: '90002:24:7',
      location: '24 км 7 пк',
      axisLabel: '24 км 7 пк',
      roadName: 'Учебная дорога Б',
      crossingWidthMetres: 7.9,
      crossingRoadLengthMetres: 40,
      revision: 1,
      updatedAt: '2026-09-28T10:00:00.000Z',
    })
    let project = savePlacement(
      decimal,
      withPost('1.25', 300, '{d50} / 0.5 км (ГОСТ Р 52289-2019, п. 5.2.2)'),
    )
    const details = createSchemeDetailsDraft(project)
    details.parameters.signDistancesMetres.d50 = '47.5'
    project = applySchemeDetails(project, details)
    const printed = texts(drawSheet(projectDraftSheet(project), options).nodes)
    expect(printed).toContain('ширина проезжей части 7,9 м')
    // Ссылка на пункт в подписи составителя остаётся как введена.
    expect(printed).toContain('47,5 м / 0,5 км (ГОСТ Р 52289-2019, п. 5.2.2)')
    expect(printed.join(' ')).not.toMatch(/\d\.\d+ (м|км)/)
  })

  it('stops printing when a direction label does not fit', () => {
    const project = scheme()
    const draft = createSchemeDetailsDraft(project)
    draft.parameters.directions.left = 'на очень далёкий населённый пункт '.repeat(4)
    const drawing = drawSheet(projectDraftSheet(applySchemeDetails(project, draft)), options)
    expect(drawing.overflow).toEqual(['Направление слева'])
  })

  it('checks the sheet border against the distance leader, not only the signs', () => {
    const post = withPost('1.25', 300, '{d300}')
    post.side = 'up'
    post.y = '-250'
    const project = savePlacement(scheme(), post)
    const drawing = drawSheet(projectDraftSheet(project), options)
    const [item] = drawing.objectBoxes
    expect(item!.box[1]).toBeGreaterThan(0)
    expect(item!.extent[1]).toBeLessThan(0)
    expect(objectsOutside(drawing)).toEqual([item!.id])
  })

  it('omits the draft mark and service lines on a release sheet only', () => {
    const sheet = projectDraftSheet(scheme())
    const draft = texts(drawSheet(sheet, options).nodes).join(' ')
    const release = texts(drawSheet(sheet, { ...options, release: true }).nodes).join(' ')
    for (const service of ['ЧЕРНОВИК', 'Проект не сохранён', 'учебный каталог'])
      expect(draft).toContain(service)
    for (const service of ['ЧЕРНОВИК', 'Проект не сохранён', 'учебный каталог'])
      expect(release).not.toContain(service)
    // Пометка о решении составителя нужна при сверке; на выпускном листе её нет.
    expect(draft).toContain('вне населённого пункта (решение составителя).')
    expect(draft).toContain('Типоразмер знаков II (решение составителя).')
    expect(release).toContain('приняты для участка вне населённого пункта.')
    expect(release).toContain('Типоразмер знаков II.')
    expect(release).not.toContain('решение составителя')
    // Нормативный источник остаётся на выпускном листе.
    expect(release).toContain('ОДМ 218.6.019-2016, приложение Б, рис. Б.34')
    expect(release).toContain('Утверждаю:')
    expect(release).toContain('Условные обозначения:')
  })
})
