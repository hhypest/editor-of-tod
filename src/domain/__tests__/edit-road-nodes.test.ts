import { describe, expect, it } from 'vitest'
import raw from '../../../tests/fixtures/frozen/projects/project-v12-native-b34.json?raw'
import { importSchemeJson, exportSchemeJson } from '../import'
import {
  newRoadNodeDraft,
  createRoadNodeDraft,
  saveRoadNode,
  removeRoadNode,
  RoadNodeEditError,
  LINKED_ROAD_NODE_DELETE_PROBLEM,
} from '../edit-road-nodes'
import { recoveryWriteSchema, placementDraftSchema } from '../recovery'
import { createPlacementDraft } from '../edit-placements'
import { startHistory, recordEdit, undoEdit, redoEdit } from '../edit-history'
import { releaseProblems } from '../release-readiness'
import { ROAD_LAYOUT_PROBLEM } from '../road-layout-readiness'

const project = () => importSchemeJson(raw).scheme

describe('manual road node editing before geometry', () => {
  it('adds a complete junction with its own ID, preserving all objects and previous nodes', () => {
    const previous = project()
    const untouched = structuredClone(previous)
    const draft = newRoadNodeDraft('junction')
    draft.metres = '120,5'
    draft.approach = 'right'
    draft.side = 'up'
    draft.roadKind = 'yard'
    draft.name = 'Учебный выезд'
    const next = saveRoadNode(previous, draft)
    expect(previous).toEqual(untouched)
    expect(next.roadLayout.nodes.at(-1)).toEqual({
      id: 4,
      origin: 'manual',
      kind: 'junction',
      position: { approach: 'right', from: 'E', metres: 120.5 },
      sheetOffsetXSvg: null,
      side: 'up',
      roadKind: 'yard',
      name: 'Учебный выезд',
      sideWarningRequested: false,
    })
    expect(next.roadLayout.nextNodeId).toBe(5)
    expect(next.roadLayout.nodes.slice(0, -1)).toEqual(previous.roadLayout.nodes)
    const { roadLayout: _next, ...rest } = next
    const { roadLayout: _old, ...oldRest } = previous
    void _next
    void _old
    expect(rest).toEqual(oldRest)
    expect(next.roadLayout.links).toEqual(previous.roadLayout.links)
    expect(importSchemeJson(exportSchemeJson(next)).scheme).toEqual(next)
    expect(releaseProblems(next)).toContain(ROAD_LAYOUT_PROBLEM)
  })

  it('keeps source provenance, drawing offset, links, installation and plates while editing a connected node', () => {
    const previous = project()
    previous.roadLayout.nodes[0]!.origin = 'legacy-v1'
    previous.roadLayout.nodes[0]!.sheetOffsetXSvg = -211
    previous.roadLayout.links[0]!.installation = { from: 'L0', metres: 50 }
    const draft = createRoadNodeDraft(previous.roadLayout.nodes[0]!)
    draft.metres = '0'
    draft.approach = 'right'
    draft.name = 'Переименовано'
    draft.side = 'up'
    draft.sideWarningRequested = false
    const next = saveRoadNode(previous, draft)
    expect(next.roadLayout.nodes[0]).toMatchObject({
      id: 1,
      origin: 'legacy-v1',
      sheetOffsetXSvg: -211,
      name: 'Переименовано',
      position: { approach: 'right', from: 'E', metres: 0 },
    })
    expect(next.roadLayout.links).toEqual(previous.roadLayout.links)
    expect(next.placements).toEqual(previous.placements)
    expect(next.source).toEqual(previous.source)
    expect(next.crossing).toEqual(previous.crossing)
    expect(next.signImages).toEqual(previous.signImages)
    expect(next.reviewMarks).toEqual(previous.reviewMarks)
    expect(next.decisionEvidence).toEqual(previous.decisionEvidence)
  })

  it('edits the terminus branches and permits a new terminus only after deleting an unlinked one', () => {
    const previous = project()
    const tee = previous.roadLayout.nodes[2]!
    const draft = createRoadNodeDraft(tee)
    draft.branchUp = 'Северная ветвь'
    draft.branchDown = 'Южная ветвь'
    draft.metres = '75.25'
    expect(saveRoadNode(previous, draft).roadLayout.nodes[2]).toMatchObject({
      id: 3,
      kind: 'terminal-tee',
      branchNames: { up: 'Северная ветвь', down: 'Южная ветвь' },
      position: { approach: 'right', from: 'E', metres: 75.25 },
    })
    const second = newRoadNodeDraft('terminal-tee')
    second.metres = '10'
    expect(() => saveRoadNode(previous, second)).toThrow('уже есть конечный Т-перекрёсток')
    const unlinked = {
      ...previous,
      roadLayout: {
        ...previous.roadLayout,
        links: previous.roadLayout.links.filter((link) => link.nodeId !== tee.id),
      },
    }
    const without = removeRoadNode(unlinked, tee.id)
    expect(saveRoadNode(without, second).roadLayout.nodes.at(-1)).toMatchObject({
      id: 4,
      kind: 'terminal-tee',
      position: { approach: 'left', from: 'L0', metres: 10 },
    })
  })

  it.each(['', ' ', '-1', 'NaN', 'Infinity', '1e3', '1.2.3', '10 м'])(
    'refuses invalid metres %j without changing the scheme',
    (metres) => {
      const previous = project(),
        before = structuredClone(previous)
      const draft = newRoadNodeDraft('junction')
      draft.metres = metres
      expect(() => saveRoadNode(previous, draft)).toThrow(RoadNodeEditError)
      expect(previous).toEqual(before)
    },
  )

  it('does not change a node kind, revive a missing ID or silently accept extra draft fields', () => {
    const previous = project(),
      draft = createRoadNodeDraft(previous.roadLayout.nodes[0]!)
    draft.nodeKind = 'terminal-tee'
    expect(() => saveRoadNode(previous, draft)).toThrow('изменило вид')
    draft.nodeKind = 'junction'
    draft.id = 999
    expect(() => saveRoadNode(previous, draft)).toThrow('больше не существует')
    expect(() => saveRoadNode(previous, { ...draft, unexpected: 1 } as typeof draft)).toThrow(
      'данные формы повреждены',
    )
  })

  it('refuses linked removal and deletes an unlinked node without reusing IDs or touching manual objects', () => {
    const previous = project(),
      before = structuredClone(previous)
    expect(() => removeRoadNode(previous, 1)).toThrow(LINKED_ROAD_NODE_DELETE_PROBLEM)
    expect(previous).toEqual(before)
    expect(() => removeRoadNode(previous, 999)).toThrow('не найдено')
    const removed = removeRoadNode(previous, 2)
    expect(removed.roadLayout.nextNodeId).toBe(4)
    expect(removed.placements).toEqual(previous.placements)
    expect(removed.roadLayout.links).toEqual(previous.roadLayout.links)
    const draft = newRoadNodeDraft('junction')
    draft.metres = '20'
    expect(saveRoadNode(removed, draft).roadLayout.nodes.at(-1)?.id).toBe(4)
    const history = recordEdit(startHistory(previous), removed)
    expect(undoEdit(history).present).toEqual(previous)
    expect(redoEdit(undoEdit(history)).present).toEqual(removed)
  })

  it('recovers incomplete road input in the existing object slot while retaining old placement drafts', () => {
    const scheme = project(),
      draft = newRoadNodeDraft('junction')
    draft.metres = '-'
    draft.name = 'Незавершённое название'
    const base = {
      sessionId: crypto.randomUUID(),
      scheme,
      baseRevision: null,
      detailsDraft: null,
      fileName: 'учебный.json',
      expectedVersion: 0,
    }
    const encoded = JSON.stringify(recoveryWriteSchema.parse({ ...base, placementDraft: draft }))
    expect(recoveryWriteSchema.parse(JSON.parse(encoded)).placementDraft).toEqual(draft)
    expect(placementDraftSchema.safeParse(draft).success).toBe(false)
    expect(() => saveRoadNode(scheme, draft)).toThrow(RoadNodeEditError)
    const placement = createPlacementDraft(scheme.placements[0]!)
    expect(
      recoveryWriteSchema.parse({ ...base, placementDraft: placement }).placementDraft,
    ).toEqual(placement)
  })
})
