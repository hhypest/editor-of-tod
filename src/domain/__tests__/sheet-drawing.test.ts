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

  it('stacks the signs of one post in a row by the pole and labels codes and distance', () => {
    let project = savePlacement(scheme(), withPost('1.25, 3.24_50_ж, 8.2.1', 300))
    const draft = createSchemeDetailsDraft(project)
    draft.parameters.signDistancesMetres.d50 = '50'
    project = applySchemeDetails(project, draft)
    const drawing = drawSheet(projectDraftSheet(project), options)
    const post = drawing.nodes.find((node) => node.t === 'group' && node.objectId)
    if (!post || post.t !== 'group') throw new Error('Post group expected')
    const signs = post.children.filter((node) => node.t === 'sign')
    expect(signs.map((node) => node.code)).toEqual(['1.25', '3.24_ж', '8.2.1'])
    const xs = signs.map((node) => node.x)
    expect(xs).toEqual([...xs].sort((a, b) => a - b))
    // Табличка ниже знака, и её ширина следует пропорциям PNG.
    const plate = signs[2]!
    expect(plate.h).toBeLessThan(signs[0]!.h)
    expect(plate.w / plate.h).toBeCloseTo(2)
    expect(texts(post.children)).toEqual(['1.25', '3.24', '8.2.1', '50 м'])
    expect(drawing.signCodes).toEqual(expect.arrayContaining(['1.25', '3.24_ж', '8.2.1']))
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
    expect(all).toContain(
      '1. Пропуск транспорта регулируют два регулировщика у начала и конца места работ (решение составителя).',
    )
    expect(all).toContain(
      '2. Регулировщики стоят не ближе 15 м до рабочей зоны (ОДМ 218.6.019, таблица 5).',
    )
  })

  it('prints the carriageway width as recorded and never derives a lane width', () => {
    const linked = linkPu66Card(scheme(), {
      referenceId: '90002:24:7',
      location: '24 км 7 пк',
      axisLabel: '24 км 7 пк',
      roadName: 'Учебная дорога Б',
      crossingWidthMetres: '6,10',
      revision: 1,
      updatedAt: '2026-09-28T10:00:00.000Z',
    })
    const joined = texts(drawSheet(projectDraftSheet(linked), options).nodes).join(' ')
    expect(joined).toContain('ширина проезжей части 6,10 м')
    expect(joined).not.toContain('полоса')
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
    // Нормативный источник остаётся на выпускном листе.
    expect(release).toContain('ОДМ 218.6.019-2016, приложение Б, рис. Б.34')
    expect(release).toContain('Утверждаю:')
    expect(release).toContain('Условные обозначения:')
  })
})
