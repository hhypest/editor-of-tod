import { describe, expect, it } from 'vitest'
import raw from '../../../tests/fixtures/frozen/projects/project-v12-native-b34.json?raw'
import { importSchemeJson, exportSchemeJson } from '../import'
import {
  createPlacementDraft,
  newSignDraft,
  savePlacement,
  removePlacement,
  PlacementEditError,
} from '../edit-placements'
import { createRoadObjectLinkDraft, editedRoadObjectLinks } from '../road-object-link-draft'
import { recoveryWriteSchema } from '../recovery'
import { startHistory, recordEdit, undoEdit, redoEdit } from '../edit-history'
import { removeRoadNode } from '../edit-road-nodes'
import { roadLayoutProblem } from '../road-layout-readiness'

function subject() {
  const scheme = importSchemeJson(raw).scheme
  const link = scheme.roadLayout.links[0]!
  link.origin = 'legacy-v1'
  const post = scheme.placements.find((post) => post.id === link.placementId)!
  const draft = createPlacementDraft(post, scheme.roadLayout)
  if (draft.kind !== 'sign-post' || post.kind !== 'sign-post' || !draft.roadLink)
    throw Error('Linked post required')
  return { scheme, link, post, draft, fields: draft.roadLink }
}
describe('explicit manual associations and independent installation distances', () => {
  it('changes only the selected association, retains node metres, plate values, coordinates and other objects', () => {
    const { scheme, link, post, draft, fields } = subject(),
      before = structuredClone(scheme)
    fields.installationKnown = true
    fields.installationFrom = 'L0'
    fields.installationMetres = '50,5'
    const updated = savePlacement(scheme, draft)
    expect(updated.roadLayout.links.find((item) => item.placementId === post.id)).toEqual({
      ...link,
      origin: 'manual',
      installation: { from: 'L0', metres: 50.5 },
    })
    expect(updated.roadLayout.nodes).toEqual(scheme.roadLayout.nodes)
    expect(updated.placements.find((item) => item.id === post.id)).toMatchObject({
      position: post.position,
      signIds: post.signIds,
      distance: post.distance,
      generatedByTemplate: false,
    })
    expect(updated.placements.filter((item) => item.id !== post.id)).toEqual(
      scheme.placements.filter((item) => item.id !== post.id),
    )
    expect(updated.roadLayout.links.filter((item) => item.placementId !== post.id)).toEqual(
      scheme.roadLayout.links.filter((item) => item.placementId !== post.id),
    )
    expect(updated.source).toEqual(scheme.source)
    expect(importSchemeJson(exportSchemeJson(updated)).scheme).toEqual(updated)
    expect(roadLayoutProblem(updated)).toBeTruthy()
    expect(scheme).toEqual(before)
  })
  it('retains the exact historical association when unchanged or absent in an old form', () => {
    const { scheme, link, post, draft } = subject()
    expect(savePlacement(scheme, draft).roadLayout.links).toEqual(scheme.roadLayout.links)
    expect(savePlacement(scheme, createPlacementDraft(post)).roadLayout.links).toEqual(
      scheme.roadLayout.links,
    )
    expect(
      editedRoadObjectLinks(scheme.roadLayout, post.id, createRoadObjectLinkDraft(link)),
    ).toEqual(scheme.roadLayout.links)
  })
  it.each(['', ' ', '-', '-1', 'NaN', 'Infinity', '1e3', '50 м'])(
    'refuses invalid known installation %j without changing the scheme',
    (metres) => {
      const { scheme, draft, fields } = subject(),
        before = structuredClone(scheme)
      fields.installationKnown = true
      fields.installationMetres = metres
      expect(() => savePlacement(scheme, draft)).toThrow(PlacementEditError)
      expect(scheme).toEqual(before)
    },
  )
  it.each(['L0', 'E', 'node-axis'] as const)(
    'keeps zero and unknown distance separate for %s',
    (from) => {
      const { scheme, draft, fields, post } = subject()
      fields.installationKnown = true
      fields.installationFrom = from
      fields.installationMetres = '0'
      const zero = savePlacement(scheme, draft)
      expect(
        zero.roadLayout.links.find((link) => link.placementId === post.id)?.installation,
      ).toEqual({ from, metres: 0 })
      fields.installationKnown = false
      expect(
        savePlacement(zero, draft).roadLayout.links.find((link) => link.placementId === post.id)
          ?.installation,
      ).toBeNull()
    },
  )
  it('requires an existing target and a role matching its topology', () => {
    const { scheme, draft, fields } = subject()
    fields.nodeId = '999'
    expect(() => savePlacement(scheme, draft)).toThrow('больше не существует')
    fields.nodeId = String(scheme.roadLayout.nodes.find((node) => node.kind === 'terminal-tee')!.id)
    expect(() => savePlacement(scheme, draft)).toThrow('не соответствует')
    fields.role = 'tee-branch'
    expect(
      savePlacement(scheme, draft).roadLayout.links.some(
        (link) => link.role === 'tee-branch' && link.origin === 'manual',
      ),
    ).toBe(true)
    fields.nodeId = String(scheme.roadLayout.nodes.find((node) => node.kind === 'junction')!.id)
    expect(() => savePlacement(scheme, draft)).toThrow('не соответствует')
  })
  it('adds, explicitly unlinks and undoes one association without deleting the stand or reusing IDs', () => {
    const { scheme, post, draft, fields } = subject()
    fields.nodeId = ''
    const unlinked = savePlacement(scheme, draft)
    expect(unlinked.roadLayout.links.some((link) => link.placementId === post.id)).toBe(false)
    expect(unlinked.placements).toHaveLength(scheme.placements.length)
    expect(unlinked.nextPlacementId).toBe(scheme.nextPlacementId)
    const history = recordEdit(startHistory(scheme), unlinked)
    expect(undoEdit(history).present).toEqual(scheme)
    expect(redoEdit(undoEdit(history)).present).toEqual(unlinked)
    const addition = newSignDraft()
    if (addition.kind !== 'sign-post') throw Error('Post required')
    addition.signCodes = '3.24_40, 8.1.3_120'
    addition.roadLink = { ...createRoadObjectLinkDraft(), nodeId: '1', role: 'side-warning' }
    const added = savePlacement(unlinked, addition)
    expect(
      added.roadLayout.links.find((link) => link.placementId === unlinked.nextPlacementId),
    ).toMatchObject({ nodeId: 1, origin: 'manual', installation: null })
    expect(removePlacement(added, unlinked.nextPlacementId).roadLayout.links).toEqual(
      unlinked.roadLayout.links,
    )
  })
  it('keeps an explicitly unlinked post as manual when its now-unlinked node is removed', () => {
    const { scheme, draft, fields, link, post } = subject()
    scheme.roadLayout.links = [link]
    fields.nodeId = ''
    const result = removeRoadNode(savePlacement(scheme, draft), link.nodeId)
    expect(result.placements.find((item) => item.id === post.id)?.generatedByTemplate).toBe(false)
    expect(result.roadLayout.links).toEqual([])
  })
  it('recovers incomplete link input inside the existing sign-post slot while preserving old forms', () => {
    const { scheme, draft, fields, post } = subject()
    fields.installationKnown = true
    fields.installationMetres = '-'
    const input = {
      sessionId: crypto.randomUUID(),
      scheme,
      baseRevision: null,
      detailsDraft: null,
      placementDraft: draft,
      fileName: 'учебный.json',
      expectedVersion: 0,
    }
    expect(recoveryWriteSchema.parse(JSON.parse(JSON.stringify(input))).placementDraft).toEqual(
      draft,
    )
    expect(() => savePlacement(scheme, draft)).toThrow('Расстояние установки стойки')
    const old = createPlacementDraft(post)
    expect(recoveryWriteSchema.parse({ ...input, placementDraft: old }).placementDraft).toEqual(old)
  })
})
