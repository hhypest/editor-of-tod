import { describe, expect, it } from 'vitest'
import { createUnlinkedScheme } from '../create-scheme'
import { projectDraftSheet } from '../draft-sheet'
import { applySchemeDetails, createSchemeDetailsDraft } from '../edit-details'
import {
  createPlacementDraft,
  newSignDraft,
  PlacementEditError,
  savePlacement,
} from '../edit-placements'
import { exportSchemeJson, importSchemeJson } from '../import'
import { schemeSchema, upgradeSchemeV9, type Scheme } from '../model'
import { movePlacement, schemeLayout, stepPostDistance } from '../placement-workspace'
import {
  adoptPostDistances,
  distanceFromLabel,
  postCaption,
  snapPostMetres,
} from '../post-distance'
import { recoveryRecordSchema } from '../recovery'
import { releaseProblems } from '../release-readiness'
import { reviewScheme } from '../review-scheme'
import { rebuildTemplatePlacements } from '../template-placements'
import { v9Snapshot } from '../../../tests/fixtures/old-version'

function project(location: 'in' | 'out' = 'out', mode: 'two' | 'signs' = 'two'): Scheme {
  const base = createUnlinkedScheme({
    referenceId: 'TEST-DISTANCE',
    locationText: 'Учебный участок',
    directionLeft: 'А',
    directionRight: 'Б',
    frontMetres: '18',
    taperMetres: mode === 'signs' ? '15' : '10',
    bufferMetres: '10',
    speedStagesKmh: ['70', '50', '40'],
    location: 'out',
    approachSpeedKmh: '90',
    yellowTemporarySigns: true,
    workConditions: {
      kind: 'short',
      durationHours: 5,
      daylight: 'day',
      regulatorsPresent: true,
      sectionMetres: null,
    },
  })
  const scheme = schemeSchema.parse({
    ...base,
    parameters: {
      ...base.parameters,
      location,
      approachSpeedKmh: location === 'in' ? 60 : 90,
      signDistancesMetres: { d300: 300, d250: 250, d150: 150, d50: 50, n100: 100, n50: 50 },
      regulation: { ...base.parameters.regulation, mode, hourly: '180', straight: true },
    },
  })
  return rebuildTemplatePlacements(scheme).scheme
}

type Post = Extract<Scheme['placements'][number], { kind: 'sign-post' }>
const posts = (scheme: Scheme) =>
  scheme.placements.filter((item): item is Post => item.kind === 'sign-post')
const bySlot = (scheme: Scheme, slot: string) =>
  posts(scheme).find((item) => item.templateSlot === `post2:${slot}`)!
const xOf = (scheme: Scheme, post: Post) => schemeLayout(scheme).coordinates(post).x

function addPost(scheme: Scheme, approach: 'left' | 'right', metres: string): Scheme {
  const draft = newSignDraft(approach)
  if (draft.kind !== 'sign-post') throw new Error('Expected sign draft')
  draft.signCodes = '1.25'
  draft.distanceMetres = metres
  return savePlacement(scheme, draft)
}

describe('post distance to the start of works (Р1)', () => {
  it('reads a distance from a former caption only when it is a single marker or a number', () => {
    expect(distanceFromLabel('{d150}')).toEqual({ by: 'marker', marker: 'd150' })
    expect(distanceFromLabel('0')).toEqual({ by: 'metres', metres: 0 })
    expect(distanceFromLabel(' 120 м ')).toEqual({ by: 'metres', metres: 120 })
    expect(distanceFromLabel('47,5')).toEqual({ by: 'metres', metres: 47.5 })
    for (const label of [null, '', '{d300} / {d50}', '{unknown}', 'после переезда', '1,5 км'])
      expect(distanceFromLabel(label)).toBeNull()
  })

  it('writes the caption from the distance', () => {
    const distances = { d300: 300, d250: null, d150: 150, d50: 47.5, n100: null, n50: null }
    expect(postCaption({ by: 'marker', approach: 'left', marker: 'd150' }, distances)).toBe('150 м')
    expect(postCaption({ by: 'marker', approach: 'left', marker: 'd50' }, distances)).toBe('47,5 м')
    expect(postCaption({ by: 'metres', approach: 'right', metres: 0 }, distances)).toBe('0')
    // Незаполненное поле остаётся маркером: по нему лист не выпускается.
    expect(postCaption({ by: 'marker', approach: 'left', marker: 'd250' }, distances)).toBe(
      '{d250}',
    )
  })

  it.each([
    ['out', 'two'],
    ['out', 'signs'],
    ['in', 'two'],
    ['in', 'signs'],
  ] as const)(
    'keeps template posts where the figure layout puts them: %s / %s',
    (location, mode) => {
      const scheme = project(location, mode)
      const layout = schemeLayout(scheme)
      for (const post of posts(scheme)) {
        const { anchor, offsetXSvg } = post.position
        const stored = offsetXSvg + (anchor === 'abs' ? 0 : layout.anchors[anchor])
        expect(layout.coordinates(post).x, post.templateSlot).toBeCloseTo(stored)
        // Все стойки подходов имеют расстояние; «конец ограничений» — нет.
        expect(Boolean(post.distance), post.templateSlot).toBe(!post.templateSlot!.endsWith(':end'))
      }
    },
  )

  it('places a post by the order of distances, not by a uniform scale', () => {
    const scheme = addPost(addPost(project(), 'left', '200'), 'right', '100')
    const left200 = posts(scheme).at(-2)!
    const right100 = posts(scheme).at(-1)!
    // Слева расстояние растёт влево: 250 м — 200 м — 150 м.
    expect(xOf(scheme, left200)).toBeGreaterThan(xOf(scheme, bySlot(scheme, 'L:speed1')))
    expect(xOf(scheme, left200)).toBeLessThan(xOf(scheme, bySlot(scheme, 'L:narrowing')))
    // Посередине между соседними стойками шаблона.
    expect(xOf(scheme, left200)).toBeCloseTo(
      (xOf(scheme, bySlot(scheme, 'L:speed1')) + xOf(scheme, bySlot(scheme, 'L:narrowing'))) / 2,
    )
    // Справа расстояние растёт вправо: 50 м — 100 м — 150 м.
    expect(xOf(scheme, right100)).toBeGreaterThan(xOf(scheme, bySlot(scheme, 'R:zone-speed')))
    expect(xOf(scheme, right100)).toBeLessThan(xOf(scheme, bySlot(scheme, 'R:narrowing')))
    const sheet = projectDraftSheet(scheme)
    expect(sheet.placements.find((item) => item.id === left200.id)).toMatchObject({
      distanceLabel: '200 м',
    })
  })

  it('follows the stage 2 field for linked posts on both approaches', () => {
    const scheme = project()
    const details = createSchemeDetailsDraft(scheme)
    details.parameters.signDistancesMetres.d150 = '180'
    const edited = applySchemeDetails(scheme, details)
    for (const slot of ['L:narrowing', 'R:narrowing']) {
      const post = bySlot(edited, slot)
      expect(
        projectDraftSheet(edited).placements.find((item) => item.id === post.id),
      ).toMatchObject({ distanceLabel: '180 м' })
      // Место в ряду прежнее: стойки стоят по порядку расстояний.
      expect(xOf(edited, post)).toBeCloseTo(xOf(scheme, bySlot(scheme, slot)))
    }
  })

  it('compresses the template row when a post stands farther than its farthest post', () => {
    const base = project()
    const far = addPost(base, 'left', '500')
    const farPost = posts(far).at(-1)!
    const warning = bySlot(far, 'L:warning')
    // Дальняя стойка занимает край ряда, стойка 300 м сдвигается к месту работ.
    expect(xOf(far, farPost)).toBeCloseTo(xOf(base, bySlot(base, 'L:warning')))
    expect(xOf(far, warning)).toBeGreaterThan(xOf(far, farPost))
    expect(xOf(far, warning)).toBeLessThan(xOf(far, bySlot(far, 'L:speed1')))
    // Другой подход и начало работ не затронуты.
    expect(xOf(far, bySlot(far, 'R:warning'))).toBeCloseTo(xOf(base, bySlot(base, 'R:warning')))
    expect(xOf(far, bySlot(far, 'L:start'))).toBeCloseTo(xOf(base, bySlot(base, 'L:start')))
    expect(xOf(far, warning)).toBeGreaterThanOrEqual(0)
  })

  it('snaps a dragged distance to a stage 2 value or to a round number', () => {
    const stops = [0, 50, 150, 250, 300]
    expect(snapPostMetres(148.2, stops)).toBe(150)
    expect(snapPostMetres(2, stops)).toBe(0)
    expect(snapPostMetres(183, stops)).toBe(180)
    expect(snapPostMetres(72.4, stops)).toBe(70)
    expect(snapPostMetres(-20, stops)).toBe(0)
    expect(snapPostMetres(412, stops)).toBe(410)
  })

  it('turns a horizontal move into a new distance of that post only', () => {
    const scheme = project()
    const post = bySlot(scheme, 'L:narrowing')
    const target = (xOf(scheme, bySlot(scheme, 'L:speed1')) + xOf(scheme, post)) / 2
    const moved = movePlacement(scheme, post.id, Math.round(target - xOf(scheme, post)), 6)
    const result = bySlot(moved, 'L:narrowing')
    expect(result).toMatchObject({
      generatedByTemplate: false,
      distance: { by: 'metres', approach: 'left', metres: 200 },
      distanceLabel: null,
    })
    // Сохранённая условная координата не меняется, вертикальный сдвиг — меняется.
    expect(result.position).toEqual({ ...post.position, offsetYSvg: 6 })
    // Поле этапа 2 и связанная стойка другого подхода остались прежними.
    expect(moved.parameters.signDistancesMetres.d150).toBe(150)
    expect(bySlot(moved, 'R:narrowing').distance).toEqual({
      by: 'marker',
      approach: 'right',
      marker: 'd150',
    })
    // Вертикальный перенос расстояния не меняет.
    expect(bySlot(movePlacement(scheme, post.id, 0, 9), 'L:narrowing').distance).toEqual(
      post.distance,
    )
    // Перенос за начало работ даёт 0, а не отрицательное расстояние.
    expect(bySlot(movePlacement(scheme, post.id, 900, 0), 'L:narrowing').distance).toMatchObject({
      metres: 0,
    })
  })

  it('steps the distance from the keyboard in the direction seen on the screen', () => {
    const scheme = project()
    const left = bySlot(scheme, 'L:narrowing')
    const right = bySlot(scheme, 'R:narrowing')
    // Слева стрелка вправо приближает стойку к началу работ, справа — удаляет.
    expect(bySlot(stepPostDistance(scheme, left.id, 5), 'L:narrowing').distance).toMatchObject({
      by: 'metres',
      metres: 145,
    })
    expect(bySlot(stepPostDistance(scheme, right.id, 5), 'R:narrowing').distance).toMatchObject({
      by: 'metres',
      metres: 155,
    })
    const start = bySlot(scheme, 'L:start')
    expect(stepPostDistance(scheme, start.id, 10)).toBe(scheme)
    expect(() => stepPostDistance(scheme, bySlot(scheme, 'L:end').id, 5)).toThrow('не найдена')
  })

  it('edits the distance in the form and validates it', () => {
    const scheme = project()
    const post = bySlot(scheme, 'L:zone-speed')
    const draft = createPlacementDraft(post)
    if (draft.kind !== 'sign-post') throw new Error('Expected sign draft')
    expect(draft).toMatchObject({ distanceMode: 'd50', approach: 'left', distanceMetres: '' })
    draft.distanceMode = 'own'
    draft.distanceMetres = '47,5'
    expect(bySlot(savePlacement(scheme, draft), 'L:zone-speed').distance).toEqual({
      by: 'metres',
      approach: 'left',
      metres: 47.5,
    })
    for (const value of ['', 'сто', '-5']) {
      draft.distanceMetres = value
      expect(() => savePlacement(scheme, draft)).toThrow(PlacementEditError)
    }
    // Без расстояния стойка возвращается на условные координаты со своей подписью.
    draft.distanceMode = 'none'
    draft.distanceLabel = 'за переездом'
    expect(bySlot(savePlacement(scheme, draft), 'L:zone-speed')).toMatchObject({
      distance: null,
      distanceLabel: 'за переездом',
    })
    // Новая стойка подхода справа встаёт над дорогой, как стойки шаблона.
    expect(newSignDraft('right')).toMatchObject({ side: 'up', stand: 'right', distanceMode: 'own' })
    expect(newSignDraft('left')).toMatchObject({ side: 'down', stand: 'left' })
    expect(newSignDraft()).toMatchObject({ distanceMode: 'none' })
  })

  it('rejects a caption on a post that has a distance', () => {
    const scheme = project()
    const broken = {
      ...scheme,
      placements: scheme.placements.map((item) =>
        item.kind === 'sign-post' && item.distance ? { ...item, distanceLabel: '150 м' } : item,
      ),
    }
    expect(schemeSchema.safeParse(broken).success).toBe(false)
  })

  it('lists posts without a distance for review, except the end-of-restrictions posts', () => {
    const scheme = project()
    const finding = (value: Scheme) =>
      reviewScheme(value).find((item) => item.id === 'post-distance')
    expect(finding(scheme)).toBeUndefined()
    const free = newSignDraft()
    if (free.kind !== 'sign-post') throw new Error('Expected sign draft')
    free.signCodes = '3.31'
    free.x = '1500'
    const withFree = savePlacement(scheme, free)
    expect(finding(withFree)).toMatchObject({ kind: 'verify', path: 'placements' })
    expect(finding(withFree)?.detail).toContain(`№ ${posts(withFree).at(-1)!.id}`)
  })

  it('blocks the release while the field of a linked post is empty', () => {
    const scheme = project()
    const details = createSchemeDetailsDraft(scheme)
    details.parameters.signDistancesMetres.d250 = ''
    const edited = applySchemeDetails(scheme, details)
    const problems = releaseProblems(edited).filter((problem) => problem.includes('расстояние'))
    expect(problems).toHaveLength(2)
    expect(problems[0]).toContain(`Стойка № ${bySlot(edited, 'L:speed1').id}`)
    expect(reviewScheme(edited).find((item) => item.id === 'distance-d250')).toMatchObject({
      kind: 'fill',
    })
    // На листе стойка остаётся на своём месте, подпись — маркер.
    expect(xOf(edited, bySlot(edited, 'L:speed1'))).toBeCloseTo(
      xOf(scheme, bySlot(scheme, 'L:speed1')),
    )
  })

  describe('projects saved before format v10', () => {
    it('gives a distance only to posts that stay where they were drawn', () => {
      const scheme = project()
      const manual = newSignDraft()
      if (manual.kind !== 'sign-post') throw new Error('Expected sign draft')
      manual.signCodes = '1.25'
      manual.x = '333'
      manual.distanceLabel = '{d150}'
      const previous = v9Snapshot(savePlacement(scheme, manual))
      const upgraded = upgradeSchemeV9(previous)
      expect(upgraded.schemaVersion).toBe(10)
      // Стойки шаблона получили расстояния и не сдвинулись.
      expect(posts(upgraded).slice(0, -1)).toEqual(posts(scheme))
      // Ручная стойка с подписью «150 м» стоит не на месте 150 м: её не трогаем.
      expect(posts(upgraded).at(-1)).toMatchObject({
        distance: null,
        distanceLabel: '{d150}',
        position: { anchor: 'abs', offsetXSvg: 333 },
      })
      const imported = importSchemeJson(JSON.stringify(previous))
      expect(imported.format).toBe('scheme-v9')
      expect(imported.warnings.join(' ')).toContain(`У стоек № ${posts(upgraded).at(-1)!.id}`)
      // Сохранение в v10 и повторное открытие не меняют проект и не предупреждают снова.
      const reopened = importSchemeJson(exportSchemeJson(imported.scheme))
      expect(reopened.format).toBe('scheme-v10')
      expect(reopened.scheme).toEqual(imported.scheme)
      expect(reopened.warnings.join(' ')).not.toContain('У стоек')
    })

    it('does not adopt a distance beyond the template row or with unknown zone sizes', () => {
      const scheme = project()
      const source = {
        ...scheme,
        placements: [
          {
            kind: 'sign-post' as const,
            position: { anchor: 'abs' as const, offsetXSvg: 20 },
            distanceLabel: '500 м',
          },
          {
            kind: 'sign-post' as const,
            position: { anchor: 'L0' as const, offsetXSvg: -2 },
            distanceLabel: '0',
          },
        ],
      }
      const [far, start] = adoptPostDistances(source)
      expect(far).toMatchObject({ distance: null, distanceLabel: '500 м' })
      expect(start).toMatchObject({
        distance: { by: 'metres', approach: 'left', metres: 0 },
        distanceLabel: null,
      })
      const noZone = {
        ...source,
        parameters: { ...source.parameters, workZones: { b33: null, b34: null } },
      }
      expect(
        adoptPostDistances(noZone).every((post) => 'distance' in post && post.distance === null),
      ).toBe(true)
    })

    it('opens an unsent recovery copy of a post form written before v10', () => {
      const scheme = project()
      const draft = createPlacementDraft(posts(scheme)[0]!)
      if (draft.kind !== 'sign-post') throw new Error('Expected sign draft')
      const { distanceMode: _mode, approach: _approach, distanceMetres: _metres, ...old } = draft
      void _mode
      void _approach
      void _metres
      const record = recoveryRecordSchema.parse({
        sessionId: '3f0c8a52-9d1e-4b7a-8c44-5e2f6a7b8c9d',
        scheme,
        baseRevision: null,
        detailsDraft: null,
        placementDraft: old,
        fileName: 'учебный.json',
        version: 1,
        updatedAt: '2026-10-05T12:00:00.000Z',
      })
      expect(record.placementDraft).toMatchObject({ distanceMode: 'none', distanceMetres: '' })
    })
  })
})
