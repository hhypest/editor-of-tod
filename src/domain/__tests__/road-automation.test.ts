import { describe, it, expect } from 'vitest'
import { createUnlinkedScheme } from '../create-scheme'
import { schemeSchema, type Scheme } from '../model'
import { prepareRoadAutomation, applyRoadAutomation } from '../road-automation'
import { PROTOTYPE_RULES } from '../normative-parameters'
import { roadAutomationCurrent } from '../road-automation-state'
import { roadLayoutProblem } from '../road-layout-readiness'
import {
  createPlacementDraft,
  savePlacement,
  removePlacement,
  restoreRoadPlacement,
} from '../edit-placements'
import { movePlacement, schemeLayout, stepPostDistance } from '../placement-workspace'
import { createRoadNodeDraft, saveRoadNode, removeRoadNode } from '../edit-road-nodes'
import { importSchemeJson, exportSchemeJson } from '../import'
import { roadSheetNotes } from '../road-notes'
import { createSchemeDetailsDraft, applySchemeDetails } from '../edit-details'
import { recordEdit, startHistory, undoEdit, redoEdit } from '../edit-history'
import { projectDraftSheet } from '../draft-sheet'
import { drawSheet } from '../sheet-drawing'
import { releaseProblems } from '../release-readiness'

function example(
  kind: 'junction' | 'terminal-tee' = 'junction',
  approach: 'left' | 'right' = 'right',
  d = 120,
): Scheme {
  const s = createUnlinkedScheme({
    referenceId: 'TEST-ROAD-AUTO',
    locationText: 'Учебная дорога',
    directionLeft: 'А',
    directionRight: 'Б',
    frontMetres: '18',
    taperMetres: '10',
    bufferMetres: '10',
    speedStagesKmh: ['70', '50', '40'],
    location: 'out',
    approachSpeedKmh: '90',
    yellowTemporarySigns: true,
    workConditions: {
      kind: 'short',
      durationHours: 4,
      daylight: 'day',
      regulatorsPresent: true,
      sectionMetres: null,
    },
  })
  s.parameters.regulation.mode = 'two'
  s.parameters.regulation.hourly = '180'
  s.roadLayout = {
    nextNodeId: 2,
    links: [],
    nodes: [
      {
        id: 1,
        origin: 'manual',
        position:
          approach === 'left'
            ? { approach, from: 'L0', metres: d }
            : { approach, from: 'E', metres: d },
        sheetOffsetXSvg: null,
        ...(kind === 'junction'
          ? {
              kind,
              side: 'down',
              roadKind: 'road',
              name: 'Учебная ветвь',
              sideWarningRequested: true,
            }
          : { kind, branchNames: { up: 'А', down: 'Б' } }),
      },
    ],
  }
  return schemeSchema.parse(s)
}
function calculated(s = example()) {
  return applyRoadAutomation(s, prepareRoadAutomation(s))
}
function row(s: Scheme, slot: string) {
  return s.roadLayout.links.find(
    (l) => l.calculation?.ruleId === 'project-road-layout-v1' && l.calculation.slot === slot,
  )!
}
function edit(s: Scheme, id: number) {
  const d = createPlacementDraft(
    s.placements.find((p) => p.id === id)!,
    s.roadLayout,
  )
  if (d.kind !== 'sign-post') throw Error('Post expected')
  return d
}

describe('complete road automation', () => {
  it('previews without mutation and builds the main scheme together with side signs and repeats', () => {
    const s = example(),
      before = exportSchemeJson(s),
      plan = prepareRoadAutomation(s)
    expect(exportSchemeJson(s)).toBe(before)
    const next = applyRoadAutomation(s, plan)
    expect(next.placements.length).toBeGreaterThan(15)
    expect(
      next.placements.filter((p) => p.kind === 'element' && p.elementKind === 'reg'),
    ).toHaveLength(2)
    expect(row(next, 'side').installation).toEqual({ from: 'E', metres: 55 })
    expect(next.placements.find((p) => p.id === row(next, 'side').placementId)).toMatchObject({
      signIds: ['1.25', '8.1.4_120'],
    })
    expect(next.placements.find((p) => p.id === row(next, 'repeat').placementId)).toMatchObject({
      signIds: ['1.25', '8.1.1_110', '3.20_ж', '3.24_ж'],
    })
    expect(roadAutomationCurrent(next)).toBe(true)
    expect(roadLayoutProblem(next)).toBeNull()
    expect(importSchemeJson(exportSchemeJson(next)).scheme).toEqual(next)
  })
  it.each(['left', 'right'] as const)(
    'moves all posts beyond %s tee to both branches and keeps original IDs reversible',
    (approach) => {
      const s = calculated(example('terminal-tee', approach, 80)),
        hidden = s.roadLayout.automation!.hiddenSourceIds
      const copies = s.roadLayout.links.filter(
        (l) =>
          l.branchPlacement &&
          l.calculation?.ruleId === 'project-road-layout-v1' &&
          l.calculation.sourcePlacementId !== null,
      )
      expect(copies.length).toBeGreaterThanOrEqual(6)
      for (const id of hidden)
        expect(s.roadObjectExclusions?.objects.some((item) => item.post.id === id)).toBe(true)
      expect(row(s, 'main-warning').installation?.metres).toBe(75)
      expect(row(s, 'main-restrict').installation?.metres).toBe(40)
      const repeat = applyRoadAutomation(s, prepareRoadAutomation(s))
      expect(repeat.nextPlacementId).toBe(s.nextPlacementId)
      expect(repeat.placements.map((p) => p.id)).toEqual(s.placements.map((p) => p.id))
    },
  )
  it('does not invent a near-tee warning below the project minimum', () => {
    const s = calculated(example('terminal-tee', 'right', 15))
    expect(row(s, 'main-warning')).toBeUndefined()
    expect(row(s, 'main-restrict').installation?.metres).toBe(8)
    expect(
      prepareRoadAutomation(example('terminal-tee', 'right', 15)).warnings.join(' '),
    ).toContain('близко')
  })
  it('merges a repeat coinciding with a generated template post without duplicating the speed', () => {
    const s = calculated(example('junction', 'right', 60)),
      repeat = row(s, 'repeat')
    const post = s.placements.find((p) => p.id === repeat.placementId)!
    expect(
      post.kind === 'sign-post' && post.signIds.filter((code) => code.startsWith('3.24')),
    ).toHaveLength(1)
    expect(
      s.roadObjectExclusions?.objects.some(
        (item) => item.post.templateSlot === 'post2:R:zone-speed',
      ),
    ).toBe(true)
  })
  it.each(['in', 'out'] as const)(
    'includes the exact %s limit and does not calculate a yard or beyond-limit node',
    (location) => {
      const s = example('junction', 'left', location === 'in' ? 100 : 300)
      s.parameters.location = location
      expect(prepareRoadAutomation(s).rows.length).toBeGreaterThan(0)
      s.roadLayout.nodes[0]!.position.metres += 1
      expect(prepareRoadAutomation(s).rows).toHaveLength(0)
      const node = example().roadLayout.nodes[0]!
      if (node.kind !== 'junction') throw Error()
      node.roadKind = 'yard'
      s.roadLayout.nodes = [node]
      expect(prepareRoadAutomation(s).rows).toHaveLength(0)
    },
  )
  it('preserves modified and excluded outputs until explicit replacement or restoration', () => {
    const base = calculated(),
      id = row(base, 'repeat').placementId,
      d = edit(base, id)
    d.signCodes = '1.25,8.1.1_77'
    const changed = savePlacement(base, d),
      kept = applyRoadAutomation(changed, prepareRoadAutomation(changed))
    expect(kept.placements.find((p) => p.id === id)).toEqual(
      changed.placements.find((p) => p.id === id),
    )
    const accepted = applyRoadAutomation(changed, prepareRoadAutomation(changed), {
      '1:repeat': 'accept',
    })
    expect(row(accepted, 'repeat').calculation?.state).toBe('automatic')
    const excluded = removePlacement(changed, id),
      again = applyRoadAutomation(excluded, prepareRoadAutomation(excluded))
    expect(again.placements.some((p) => p.id === id)).toBe(false)
    expect(restoreRoadPlacement(again, id).placements.find((p) => p.id === id)).toEqual(
      changed.placements.find((p) => p.id === id),
    )
  })
  it('does not trust tampered previews and invalidates parameter/project changes', () => {
    const s = example(),
      plan = prepareRoadAutomation(s)
    plan.rows[0]!.signIds = ['TAMPER']
    expect(
      applyRoadAutomation(s, plan).placements.some(
        (p) => p.kind === 'sign-post' && p.signIds.includes('TAMPER'),
      ),
    ).toBe(false)
    const changed = structuredClone(s)
    changed.parameters.yellowTemporarySigns = false
    expect(() => applyRoadAutomation(changed, plan)).toThrow('изменились')
    const r = structuredClone(PROTOTYPE_RULES)
    r.parameterBasis['project-road-profile']!.confirmed = true
    expect(() => applyRoadAutomation(s, plan, {}, r)).toThrow('изменились')
  })
  it('RP4 preserves manual geometry and excluded manual state when its node is deleted', () => {
    const base = calculated(),
      id = row(base, 'side').placementId,
      changed = movePlacement(base, id, 13, 17)
    const before = schemeLayout(changed).coordinates(changed.placements.find((p) => p.id === id)!)
    const next = removeRoadNode(changed, 1)
    expect(next.roadLayout.nodes).toHaveLength(0)
    expect(next.roadLayout.links).toHaveLength(0)
    expect(schemeLayout(next).coordinates(next.placements.find((p) => p.id === id)!)).toMatchObject(
      { x: before.x, y: before.y },
    )
    expect(next.roadLayout.detached?.[0]?.previousLink.calculation?.state).toBe('modified')
    const excluded = removePlacement(changed, id),
      deleted = removeRoadNode(excluded, 1)
    expect(deleted.roadObjectExclusions?.objects.some((item) => item.post.id === id)).toBe(true)
    const restored = restoreRoadPlacement(deleted, id)
    expect(
      schemeLayout(restored).coordinates(restored.placements.find((p) => p.id === id)!),
    ).toMatchObject({ x: before.x, y: before.y })
  })
  it('RP4 detaches a modified post on semantic node edits but leaves an independent sheet offset reversible', () => {
    const s = movePlacement(calculated(), row(calculated(), 'side').placementId, 10, 0),
      d = createRoadNodeDraft(s.roadLayout.nodes[0]!)
    d.metres = '130'
    const next = saveRoadNode(s, d)
    expect(next.roadLayout.detached).toHaveLength(1)
    expect(roadAutomationCurrent(next)).toBe(false)
  })
  it('preserves note edits through recalculation and blocks stale manual notes until reviewed', () => {
    const s = calculated(),
      d = createSchemeDetailsDraft(s)
    expect(roadSheetNotes(s).join(' ')).toContain('УГИБДД')
    d.roadNotesText = 'Собственная редакция.'
    const changed = applySchemeDetails(s, d)
    expect(roadSheetNotes(applyRoadAutomation(changed, prepareRoadAutomation(changed)))).toEqual([
      'Собственная редакция.',
    ])
    const d2 = createSchemeDetailsDraft(changed)
    d2.parameters.regulation.hourly = '200'
    expect(roadSheetNotes(applySchemeDetails(changed, d2))).toEqual(['Собственная редакция.'])
  })
  it('requires the confirmed project profile for release and groups the whole application in one history step', () => {
    const s = example(),
      next = calculated(s),
      history = recordEdit(startHistory(s), next)
    expect(undoEdit(history).present).toEqual(s)
    expect(redoEdit(undoEdit(history)).present).toEqual(next)
    expect(releaseProblems(next)).toContain(
      'Подтвердите профиль автоматики примыканий в нормативных параметрах и примените полный план.',
    )
    const rules = structuredClone(PROTOTYPE_RULES)
    rules.parameterBasis['project-road-profile']!.confirmed = true
    const confirmed = applyRoadAutomation(s, prepareRoadAutomation(s, rules), {}, rules)
    expect(roadLayoutProblem(confirmed, rules)).toBeNull()
    expect(roadLayoutProblem(confirmed, PROTOTYPE_RULES)).not.toBeNull()
  })
})

it.each(['left', 'right'] as const)(
  'keeps %s tee packing stable, mirrored and reversible',
  (approach) => {
    const original = example('terminal-tee', approach, 80),
      before = exportSchemeJson(original)
    const s = calculated(original)
    expect(exportSchemeJson(original)).toBe(before)
    const again = applyRoadAutomation(s, prepareRoadAutomation(s))
    expect(again).toEqual(s)
    expect(prepareRoadAutomation(s).rows.every((row) => row.kind === 'unchanged')).toBe(true)
    expect(s.placements.find((p) => p.id === row(s, 'side-up').placementId)).toMatchObject({
      signIds: ['1.25', approach === 'left' ? '8.1.4_80' : '8.1.3_80'],
    })
    const drawing = drawSheet(projectDraftSheet(s), {
      signSizes: new Map(),
      catalogLabel: '',
      revisionLabel: '',
    })
    expect(
      drawing.roadProblems ?? [],
      JSON.stringify({
        nodes: s.roadLayout.nodes,
        posts: s.placements.filter((p) =>
          drawing.roadProblems?.some((e) => e.objectIds.includes(p.id)),
        ),
        positions: s.roadLayout.automation?.layoutPositions,
      }),
    ).toEqual([])
    expect(importSchemeJson(exportSchemeJson(s)).scheme).toEqual(s)
  },
)
it('keeps packed drag independent of metres and honours an explicit distance edit', () => {
  const s = calculated(),
    id = row(s, 'repeat').placementId
  const moved = movePlacement(s, id, 14, 10)
  expect(moved.placements.find((p) => p.id === id)).toMatchObject({ distance: { metres: 110 } })
  const before = schemeLayout(s).coordinates(s.placements.find((p) => p.id === id)!)
  expect(schemeLayout(moved).coordinates(moved.placements.find((p) => p.id === id)!)).toMatchObject(
    { x: before.x + 14, y: before.y + 10 },
  )
  const d = edit(moved, id)
  d.distanceMetres = '90'
  expect(
    savePlacement(moved, d).roadLayout.automation!.layoutPositions!.some(
      (p) => p.placementId === id,
    ),
  ).toBe(false)
  expect(
    stepPostDistance(moved, id, 5).roadLayout.automation!.layoutPositions!.some(
      (p) => p.placementId === id,
    ),
  ).toBe(false)
})
it('regenerates automatic outputs with stable IDs after a semantic node edit', () => {
  const s = calculated(),
    id = row(s, 'repeat').placementId,
    d = createRoadNodeDraft(s.roadLayout.nodes[0]!)
  d.metres = '130'
  const changed = saveRoadNode(s, d),
    next = calculated(changed)
  expect(row(next, 'repeat').placementId).toBe(id)
  expect(row(next, 'repeat').installation?.metres).toBe(120)
  expect(roadAutomationCurrent(next)).toBe(true)
})
it('does not accept substituted or missing output identities as a complete plan', () => {
  const s = calculated(),
    bad = structuredClone(s)
  bad.roadLayout.automation!.outputs[0]!.placementId = bad.placements.find(
    (p) => p.kind === 'element',
  )!.id
  expect(roadAutomationCurrent(bad)).toBe(false)
  const duplicate = structuredClone(s)
  duplicate.roadLayout.automation!.outputs.push(duplicate.roadLayout.automation!.outputs[0]!)
  expect(schemeSchema.safeParse(duplicate).success).toBe(false)
})

it('preserves and moves a detached packed main-road edit without changing its old metres', () => {
  const s = calculated(),
    id = row(s, 'repeat').placementId,
    manual = movePlacement(s, id, 14, 8)
  const detached = removeRoadNode(manual, 1),
    before = schemeLayout(detached).coordinates(detached.placements.find((p) => p.id === id)!)
  const moved = movePlacement(detached, id, 9, 7)
  expect(schemeLayout(moved).coordinates(moved.placements.find((p) => p.id === id)!)).toMatchObject(
    { x: before.x + 9, y: before.y + 7 },
  )
  expect(moved.placements.find((p) => p.id === id)).toEqual(
    manual.placements.find((p) => p.id === id),
  )
})
it('requires review of retained own notes after work conditions change', () => {
  const s = calculated(),
    d = createSchemeDetailsDraft(s)
  d.roadNotesText = 'Согласованная собственная редакция.'
  const edited = applySchemeDetails(s, d),
    d2 = createSchemeDetailsDraft(edited)
  d2.parameters.workConditions.daylight = 'night'
  const changed = applySchemeDetails(edited, d2)
  expect(releaseProblems(changed).join(' ')).toContain('Условия примечаний изменились')
  const review = createSchemeDetailsDraft(changed)
  review.roadNotesReviewed = true
  expect(releaseProblems(applySchemeDetails(changed, review)).join(' ')).not.toContain(
    'Условия примечаний изменились',
  )
})
it('does not overwrite a former output manually reassociated with another node', () => {
  const s = calculated(),
    id = row(s, 'repeat').placementId,
    next = structuredClone(s)
  const node = structuredClone(next.roadLayout.nodes[0]!)
  node.id = 2
  node.position.metres = 200
  next.roadLayout.nodes.push(node)
  next.roadLayout.nextNodeId = 3
  const link = next.roadLayout.links.find((l) => l.placementId === id)!
  delete link.calculation
  link.nodeId = 2
  const post = next.placements.find((p) => p.id === id)!
  if (post.kind !== 'sign-post') throw Error()
  post.signIds = ['1.25', '8.1.1_77']
  const applied = calculated(schemeSchema.parse(next))
  expect(applied.placements.find((p) => p.id === id)).toEqual(post)
  expect(applied.roadLayout.links.find((l) => l.placementId === id)?.nodeId).toBe(2)
  expect(row(applied, 'repeat').placementId).not.toBe(id)
})
it('preserves an explicitly excluded automatic output across semantic node edits', () => {
  const s = calculated(),
    id = row(s, 'side').placementId,
    excluded = removePlacement(s, id)
  const d = createRoadNodeDraft(excluded.roadLayout.nodes[0]!)
  d.metres = '130'
  const changed = saveRoadNode(excluded, d),
    applied = calculated(changed)
  expect(changed.roadObjectExclusions?.objects.find((item) => item.post.id === id)).toEqual(
    excluded.roadObjectExclusions?.objects.find((item) => item.post.id === id),
  )
  expect(applied.placements.some((p) => p.id === id)).toBe(false)
  expect(applied.roadObjectExclusions?.objects.some((item) => item.post.id === id)).toBe(true)
  const deleted = removeRoadNode(excluded, 1)
  expect(deleted.roadObjectExclusions?.objects.some((item) => item.post.id === id)).toBe(true)
})
