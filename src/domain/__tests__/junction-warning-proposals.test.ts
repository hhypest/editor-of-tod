import { describe, expect, it } from 'vitest'
import raw from '../../../tests/fixtures/frozen/projects/project-v15-tee-proposals-b34.json?raw'
import { schemeSchema, schemeV15Schema, type Scheme } from '../model'
import { importSchemeJson, exportSchemeJson } from '../import'
import {
  prepareJunctionWarnings,
  applyJunctionWarnings,
  junctionWarningReason,
} from '../junction-warning-proposals'
import { PROTOTYPE_RULES } from '../normative-parameters'
import {
  createPlacementDraft,
  savePlacement,
  removePlacement,
  restoreRoadPlacement,
} from '../edit-placements'
import { movePlacement } from '../placement-workspace'
import { recordEdit, startHistory, undoEdit, redoEdit } from '../edit-history'
import { createRoadNodeDraft, saveRoadNode } from '../edit-road-nodes'
import { roadLayoutProblem } from '../road-layout-readiness'
import { distancePlate, drawableWithoutImage } from '../sign-code'

function example(
  approach: 'left' | 'right' = 'right',
  side: 'up' | 'down' = 'up',
  metres = 120,
): Scheme {
  const base = importSchemeJson(raw).scheme
  return schemeSchema.parse({
    ...base,
    placements: [],
    nextPlacementId: 10,
    roadObjectExclusions: undefined,
    parameters: { ...base.parameters, location: 'out' },
    roadLayout: {
      nextNodeId: 2,
      nodes: [
        {
          id: 1,
          kind: 'junction',
          origin: 'manual',
          position:
            approach === 'left'
              ? { approach, from: 'L0', metres }
              : { approach, from: 'E', metres },
          sheetOffsetXSvg: null,
          side,
          roadKind: 'road',
          name: 'Учебная дорога',
          sideWarningRequested: true,
        },
      ],
      links: [],
    },
  })
}
function calculated() {
  const base = example()
  return applyJunctionWarnings(base, prepareJunctionWarnings(base, [1]))
}
function edit(scheme: Scheme) {
  const draft = createPlacementDraft(scheme.placements[0]!, scheme.roadLayout)
  if (draft.kind !== 'sign-post') throw Error('Post expected')
  return draft
}

describe('requested junction warning proposals', () => {
  it('freezes v15 independently and migrates existing tee states without adoption', () => {
    const old = schemeV15Schema.parse(JSON.parse(raw)),
      current = importSchemeJson(raw).scheme
    expect(current).toEqual({ ...old, schemaVersion: 16 })
    expect(schemeV15Schema.safeParse({ ...calculated(), schemaVersion: 15 }).success).toBe(false)
  })
  it.each([
    ['left', 'down', '8.1.3_120'],
    ['left', 'up', '8.1.4_120'],
    ['right', 'down', '8.1.4_120'],
    ['right', 'up', '8.1.3_120'],
  ] as const)(
    'previews %s/%s using the approved plate %s without installation metres',
    (approach, side, code) => {
      const scheme = example(approach, side),
        before = exportSchemeJson(scheme),
        plan = prepareJunctionWarnings(scheme, [1])
      expect(exportSchemeJson(scheme)).toBe(before)
      expect(plan.items[0]?.post.signIds).toEqual(['1.25', code])
      expect(plan.items[0]?.link).toMatchObject({
        installation: null,
        branchPlacement: { branch: side, rotation: approach === 'left' ? 270 : 90 },
        calculation: {
          sourcePlacementId: null,
          state: 'automatic',
          rangeBasis: { value: 300, confirmed: false },
        },
      })
      const applied = applyJunctionWarnings(scheme, plan)
      expect(applied.placements).toHaveLength(1)
      expect(applyJunctionWarnings(applied, prepareJunctionWarnings(applied, [1]))).toBe(applied)
      expect(applied.nextPlacementId).toBe(11)
      expect(roadLayoutProblem(applied)).not.toBeNull()
    },
  )
  it.each(['in', 'out'] as const)(
    'uses an inclusive parameter boundary in %s and rejects beyond it',
    (location) => {
      const limit = location === 'in' ? 100 : 300,
        scheme = example('left', 'down', limit)
      scheme.parameters.location = location
      expect(junctionWarningReason(scheme, scheme.roadLayout.nodes[0]!)).toBeNull()
      scheme.roadLayout.nodes[0]!.position.metres += 0.1
      expect(() => prepareJunctionWarnings(scheme, [1])).toThrow('границы включения')
      const rules = structuredClone(PROTOTYPE_RULES)
      rules.parameterBasis[
        location === 'in' ? 'project-junction-range-in' : 'project-junction-range-out'
      ]!.value = limit + 1
      expect(prepareJunctionWarnings(scheme, [1], rules).items).toHaveLength(1)
    },
  )
  it('preserves a fractional plate value without a new rounding policy', () => {
    const code = prepareJunctionWarnings(example('left', 'down', 120.5), [1]).items[0]!.post
      .signIds[1]!
    expect(code).toBe('8.1.3_120.5')
    expect(distancePlate(code)?.value).toBe('120.5')
    expect(drawableWithoutImage(code)).toBe(true)
  })
  it.each(['yard', 'request', 'location', 'tee', 'missing'] as const)(
    'rejects an unsupported source: %s',
    (mode) => {
      const scheme = example(),
        node = scheme.roadLayout.nodes[0]!
      if (node.kind !== 'junction') throw Error('Junction expected')
      if (mode === 'yard') node.roadKind = 'yard'
      if (mode === 'request') node.sideWarningRequested = false
      if (mode === 'location') scheme.parameters.location = 'auto'
      if (mode === 'tee') {
        scheme.roadLayout.nodes.push({
          id: 2,
          kind: 'terminal-tee',
          origin: 'manual',
          position: { ...node.position },
          sheetOffsetXSvg: null,
          branchNames: { up: 'А', down: 'Б' },
        })
        scheme.roadLayout.nextNodeId = 3
      }
      expect(() => prepareJunctionWarnings(scheme, mode === 'missing' ? [999] : [1])).toThrow()
    },
  )
  it('does not adopt or duplicate a saved manual warning, including an excluded one', () => {
    const scheme = calculated()
    delete scheme.roadLayout.links[0]!.calculation
    for (const state of [scheme, removePlacement(scheme, 10)])
      expect(() => prepareJunctionWarnings(state, [1])).toThrow('ручная предупреждающая')
  })
  it.each(['sign', 'measurement', 'position'] as const)(
    'protects a manual %s change until explicit acceptance',
    (kind) => {
      const base = calculated(),
        draft = edit(base)
      if (kind === 'sign') draft.signCodes = '1.25,8.1.4_77'
      if (kind === 'measurement') {
        draft.roadLink!.installationKnown = true
        draft.roadLink!.installationMetres = '55'
        draft.roadLink!.installationFrom = 'E'
      }
      const changed =
        kind === 'position' ? movePlacement(base, 10, 10, 0) : savePlacement(base, draft)
      expect(changed.roadLayout.links[0]!.calculation?.state).toBe('modified')
      const plan = prepareJunctionWarnings(changed, [1])
      expect(applyJunctionWarnings(changed, plan)).toBe(changed)
      expect(applyJunctionWarnings(changed, plan, { 1: 'accept' })).toEqual(base)
    },
  )
  it('retains automatic on no-op and preserves modified exclusion through ordinary restore', () => {
    const base = calculated()
    expect(savePlacement(base, edit(base)).roadLayout.links[0]!.calculation?.state).toBe(
      'automatic',
    )
    const changed = movePlacement(base, 10, 10, 0),
      excluded = removePlacement(changed, 10),
      plan = prepareJunctionWarnings(excluded, [1])
    expect(plan.items[0]!.kind).toBe('excluded')
    expect(applyJunctionWarnings(excluded, plan)).toBe(excluded)
    expect(restoreRoadPlacement(excluded, 10)).toEqual(changed)
    expect(applyJunctionWarnings(excluded, plan, { 1: 'restore' })).toEqual(base)
  })
  it('updates an automatic plate after the node distance changes and preserves the old basis on manual keep', () => {
    for (const modified of [false, true]) {
      const base = modified ? movePlacement(calculated(), 10, 10, 0) : calculated(),
        draft = createRoadNodeDraft(base.roadLayout.nodes[0]!)
      draft.metres = '130'
      const changed = saveRoadNode(base, draft),
        plan = prepareJunctionWarnings(changed, [1]),
        applied = applyJunctionWarnings(changed, plan)
      expect(applied.placements[0]!.kind === 'sign-post' && applied.placements[0]!.signIds).toEqual(
        ['1.25', modified ? '8.1.3_120' : '8.1.3_130'],
      )
      expect(applied.roadLayout.links[0]!.calculation?.nodePosition.metres).toBe(
        modified ? 120 : 130,
      )
    }
  })
  it('invalidates a plan after document or parameter changes and recomputes mutable preview rows', () => {
    const scheme = example(),
      plan = prepareJunctionWarnings(scheme, [1]),
      changed = structuredClone(scheme)
    changed.roadLayout.nodes[0]!.position.metres++
    expect(() => applyJunctionWarnings(changed, plan)).toThrow('изменились')
    const rules = structuredClone(PROTOTYPE_RULES)
    rules.parameterBasis['project-junction-range-out']!.confirmed = true
    expect(() => applyJunctionWarnings(scheme, plan, {}, rules)).toThrow('изменились')
    plan.items[0]!.post.signIds = ['TAMPER']
    expect(applyJunctionWarnings(scheme, plan).placements[0]).toMatchObject({
      signIds: ['1.25', '8.1.3_120'],
    })
    expect(() => applyJunctionWarnings(scheme, plan, { 999: 'restore' })).toThrow('устарело')
  })
  it('groups several node warnings in one undo step and never moves unrelated posts', () => {
    const scheme = example(),
      node = scheme.roadLayout.nodes[0]!
    scheme.roadLayout.nodes.push({
      ...node,
      id: 2,
      position: { approach: 'left', from: 'L0', metres: 80 },
    })
    scheme.roadLayout.nextNodeId = 3
    const applied = applyJunctionWarnings(scheme, prepareJunctionWarnings(scheme, [2, 1])),
      history = recordEdit(startHistory(scheme), applied)
    expect(applied.placements.map((p) => p.id)).toEqual([10, 11])
    expect(undoEdit(history).present).toEqual(scheme)
    expect(redoEdit(undoEdit(history)).present).toEqual(applied)
  })
  it.each(['duplicate', 'source', 'role', 'branch'] as const)(
    'rejects invalid junction provenance: %s',
    (mode) => {
      const scheme = calculated(),
        link = scheme.roadLayout.links[0]!
      if (mode === 'duplicate') {
        scheme.placements.push({ ...scheme.placements[0]!, id: 11 })
        scheme.nextPlacementId = 12
        scheme.roadLayout.links.push({ ...link, placementId: 11 })
      }
      if (mode === 'source')
        (link.calculation as unknown as { sourcePlacementId: number }).sourcePlacementId = 10
      if (mode === 'role') link.role = 'main-repeat'
      if (mode === 'branch') delete link.branchPlacement
      expect(schemeSchema.safeParse(scheme).success).toBe(false)
    },
  )
})
