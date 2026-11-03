import { describe, expect, it } from 'vitest'
import raw from '../../../tests/fixtures/frozen/projects/project-v14-excluded-b34.json?raw'
import { schemeSchema, schemeV14Schema } from '../model'
import { importSchemeJson, exportSchemeJson } from '../import'
import { prepareTeeProposals, applyTeeProposals, teeSourcePosts } from '../tee-proposals'
import {
  createPlacementDraft,
  savePlacement,
  removePlacement,
  restoreRoadPlacement,
} from '../edit-placements'
import { movePlacement, stepPostDistance } from '../placement-workspace'
import { recordEdit, startHistory, undoEdit, redoEdit } from '../edit-history'
import { createRoadNodeDraft, saveRoadNode } from '../edit-road-nodes'
import { roadLayoutProblem } from '../road-layout-readiness'

function example(approach: 'left' | 'right' = 'right') {
  let scheme = restoreRoadPlacement(importSchemeJson(raw).scheme, 1)
  const post = scheme.placements[0]!
  if (post.kind !== 'sign-post') throw Error('Post expected')
  scheme = {
    ...scheme,
    placements: [post],
    nextPlacementId: 2,
    roadLayout: {
      nextNodeId: 2,
      nodes: [
        {
          id: 1,
          kind: 'terminal-tee',
          origin: 'manual',
          position:
            approach === 'left'
              ? { approach, from: 'L0', metres: 120 }
              : { approach, from: 'E', metres: 120 },
          sheetOffsetXSvg: null,
          branchNames: { up: 'Север', down: 'Юг' },
        },
      ],
      links: [
        {
          placementId: 1,
          nodeId: 1,
          role: 'tee-branch',
          origin: 'legacy-v1',
          installation: { from: 'L0', metres: 50 },
        },
      ],
    },
  }
  return schemeSchema.parse(scheme)
}
function calculated() {
  const scheme = example()
  return applyTeeProposals(scheme, prepareTeeProposals(scheme, [1]))
}
function edit(scheme: ReturnType<typeof example>, id = 2) {
  const draft = createPlacementDraft(
    scheme.placements.find((p) => p.id === id)!,
    scheme.roadLayout,
  )
  if (draft.kind !== 'sign-post') throw Error('Post expected')
  return draft
}

describe('explicit tee transfer proposals and manual ownership', () => {
  it('freezes v14 and infers neither ownership nor exclusions on migration', () => {
    const old = schemeV14Schema.parse(JSON.parse(raw)),
      current = importSchemeJson(raw).scheme
    expect(current).toEqual({ ...old, schemaVersion: 15 })
    expect(current.roadLayout.links.every((link) => !link.calculation)).toBe(true)
    expect(schemeV14Schema.safeParse({ ...calculated(), schemaVersion: 14 }).success).toBe(false)
  })
  it.each(['left', 'right'] as const)(
    'previews %s without mutation and explicitly replaces a selected source with two branches',
    (approach) => {
      const scheme = example(approach),
        before = structuredClone(scheme),
        plan = prepareTeeProposals(scheme, [1])
      expect(scheme).toEqual(before)
      expect(plan.items.map((item) => item.kind)).toEqual(['create', 'create'])
      const applied = applyTeeProposals(scheme, plan)
      expect(applied.roadObjectExclusions?.objects).toEqual([
        { post: scheme.placements[0], link: scheme.roadLayout.links[0] },
      ])
      expect(applied.placements.map((p) => p.id)).toEqual([2, 3])
      expect(applied.roadLayout.links.map((link) => link.calculation)).toEqual([
        expect.objectContaining({
          ruleId: 'project-tee-transfer-v1',
          sourcePlacementId: 1,
          branch: 'up',
          state: 'automatic',
        }),
        expect.objectContaining({ sourcePlacementId: 1, branch: 'down', state: 'automatic' }),
      ])
      expect(applied.roadLayout.links.every((link) => link.installation === null)).toBe(true)
      expect(applied.roadLayout.links[0]?.branchPlacement?.rotation).toBe(
        approach === 'left' ? 270 : 90,
      )
      expect(applied.placements[0]).toMatchObject({
        signIds: scheme.placements[0]!.kind === 'sign-post' ? scheme.placements[0]!.signIds : [],
        position: scheme.placements[0]!.position,
      })
      expect(applied.source).toEqual(scheme.source)
      expect(applied.signImages).toEqual(scheme.signImages)
      expect(roadLayoutProblem(applied)).toBeTruthy()
    },
  )
  it('recalculates without duplicate IDs or spurious history edits', () => {
    const scheme = calculated(),
      plan = prepareTeeProposals(scheme, [1])
    expect(plan.items.map((item) => item.kind)).toEqual(['unchanged', 'unchanged'])
    expect(applyTeeProposals(scheme, plan)).toBe(scheme)
    expect(importSchemeJson(exportSchemeJson(scheme)).scheme).toEqual(scheme)
  })
  it.each(['sign', 'plate', 'measurement', 'branch', 'main'] as const)(
    'protects a manual %s edit until an explicit accept',
    (field) => {
      const base = calculated(),
        draft = edit(base)
      if (field === 'sign') draft.signCodes = '1.25,3.20'
      if (field === 'plate') draft.signCodes = '1.25,8.1.3_140'
      if (field === 'measurement') {
        draft.roadLink!.installationKnown = true
        draft.roadLink!.installationMetres = '55'
      }
      if (field === 'branch') draft.roadLink!.branchPlacement!.acrossSvg = '180'
      if (field === 'main') draft.roadLink!.branchPlacement!.enabled = false
      const modified = savePlacement(base, draft)
      expect(modified.roadLayout.links[0]?.calculation?.state).toBe('modified')
      const plan = prepareTeeProposals(modified, [1]),
        key = plan.items[0]!.key
      expect(plan.items[0]?.kind).toBe('modified')
      expect(applyTeeProposals(modified, plan)).toBe(modified)
      const accepted = applyTeeProposals(modified, plan, { [key]: 'accept' })
      expect(accepted.roadLayout.links[0]?.calculation?.state).toBe('automatic')
      expect(accepted.placements[0]).toEqual(base.placements[0])
      expect(accepted.roadLayout.links[0]).toEqual(base.roadLayout.links[0])
    },
  )
  it('does not mark a no-op save/move as modified, and tracks keyboard and old-form edits', () => {
    const base = calculated()
    expect(savePlacement(base, edit(base)).roadLayout.links[0]?.calculation?.state).toBe(
      'automatic',
    )
    expect(movePlacement(base, 2, 0, 0)).toBe(base)
    const moved = movePlacement(base, 2, 10, 0)
    expect(moved.roadLayout.links[0]?.calculation?.state).toBe('modified')
    const old = createPlacementDraft(base.placements[0]!)
    if (old.kind !== 'sign-post') throw Error('Post expected')
    old.signCodes = '3.24_40'
    expect(savePlacement(base, old).roadLayout.links[0]?.calculation?.state).toBe('modified')
    const draft = edit(base)
    draft.roadLink!.branchPlacement!.enabled = false
    expect(
      stepPostDistance(savePlacement(base, draft), 2, 5).roadLayout.links[0]?.calculation?.state,
    ).toBe('modified')
  })
  it('keeps excluded outputs excluded across repeat plans and allows explicit proposal restore', () => {
    const base = calculated(),
      excluded = removePlacement(base, 2),
      plan = prepareTeeProposals(excluded, [1])
    expect(plan.items[0]?.kind).toBe('excluded')
    expect(applyTeeProposals(excluded, plan)).toBe(excluded)
    const restored = applyTeeProposals(excluded, plan, { [plan.items[0]!.key]: 'restore' })
    expect(restored.placements.map((p) => p.id)).toEqual([2, 3])
    expect(restored.roadObjectExclusions?.objects.map((item) => item.post.id)).toEqual([1])
    expect(restored.nextPlacementId).toBe(base.nextPlacementId)
  })
  it('preserves modified provenance through exclude/restore and rejects loss of its source link', () => {
    const changed = movePlacement(calculated(), 2, 10, 0)
    expect(restoreRoadPlacement(removePlacement(changed, 2), 2)).toEqual(changed)
    const draft = edit(changed)
    draft.roadLink!.nodeId = ''
    expect(() => savePlacement(changed, draft)).toThrow('Связь происхождения')
  })
  it('updates automatic outputs after source changes while retaining manual siblings', () => {
    const base = calculated(),
      moved = movePlacement(base, 2, 10, 0),
      source = restoreRoadPlacement(moved, 1),
      draft = edit(source, 1)
    draft.signCodes = '1.25,8.1.3_200'
    const changed = savePlacement(source, draft),
      plan = prepareTeeProposals(changed, [1]),
      applied = applyTeeProposals(changed, plan)
    expect(plan.items.map((item) => item.kind)).toEqual(['modified', 'update'])
    expect(applied.placements.find((p) => p.id === 2)).toEqual(
      moved.placements.find((p) => p.id === 2),
    )
    expect(applied.placements.find((p) => p.id === 3)).toMatchObject({
      signIds: ['1.25', '8.1.3_200'],
    })
    expect(applied.placements.some((p) => p.id === 1)).toBe(false)
  })
  it('invalidates a preview after an applied node change and ignores tampered preview payloads', () => {
    const scheme = example(),
      plan = prepareTeeProposals(scheme, [1]),
      draft = createRoadNodeDraft(scheme.roadLayout.nodes[0]!)
    draft.metres = '130'
    expect(() => applyTeeProposals(saveRoadNode(scheme, draft), plan)).toThrow('Проект изменился')
    plan.items[0]!.post.signIds = ['PRIVATE-TAMPER']
    const originalX = scheme.placements[0]!.position.offsetXSvg
    plan.items[0]!.post.position.offsetXSvg = -999
    expect(scheme.placements[0]!.position.offsetXSvg).toBe(originalX)
    expect(applyTeeProposals(scheme, plan).placements[0]).not.toMatchObject({
      signIds: ['PRIVATE-TAMPER'],
    })
    expect(() => applyTeeProposals(scheme, plan, { bad: 'restore' })).toThrow('устарел')
  })
  it('groups source exclusion and both output posts into one undo/redo step', () => {
    const scheme = example(),
      applied = applyTeeProposals(scheme, prepareTeeProposals(scheme, [1])),
      history = recordEdit(startHistory(scheme), applied)
    expect(undoEdit(history).present).toEqual(scheme)
    expect(redoEdit(undoEdit(history)).present).toEqual(applied)
  })
  it.each(['duplicate', 'source', 'node', 'branch'] as const)(
    'rejects inconsistent calculated provenance: %s',
    (mode) => {
      const scheme = calculated(),
        link = scheme.roadLayout.links[0]!
      if (mode === 'duplicate') scheme.roadLayout.links[1]!.calculation = { ...link.calculation! }
      if (mode === 'source') link.calculation!.sourcePlacementId = 999
      if (mode === 'node') scheme.roadObjectExclusions!.objects[0]!.link.nodeId = 999
      if (mode === 'branch') delete link.branchPlacement
      expect(schemeSchema.safeParse(scheme).success).toBe(false)
    },
  )
  it('never proposes unlinked or already manually placed old posts as new sources', () => {
    const scheme = example()
    scheme.roadLayout.links[0]!.branchPlacement = {
      branch: 'up',
      alongSvg: 140,
      acrossSvg: 150,
      rotation: 90,
    }
    expect(teeSourcePosts(scheme)).toEqual([])
    expect(() => prepareTeeProposals(scheme, [1])).toThrow('Выберите')
  })
})
