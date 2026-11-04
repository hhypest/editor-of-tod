// @vitest-environment vue-renderer
import { nextTick, ref } from 'vue'
import fixture from '../../../tests/fixtures/frozen/projects/project-v17-road-automation-b34.json?raw'
import { describe, it, expect, vi } from 'vitest'
import RoadAutomation from '../RoadAutomation.vue'
import { renderComponent, content, nodes, dispatch } from './test-renderer'
import { PROTOTYPE_RULES } from '../../domain/normative-parameters'
import { removePlacement } from '../../domain/edit-placements'
import { importSchemeJson } from '../../domain/import'
import { applyRoadAutomation, prepareRoadAutomation } from '../../domain/road-automation'
const ruleRef = ref(structuredClone(PROTOTYPE_RULES))
vi.mock('../../composables/useNormativeRules', () => ({
  useNormativeRules: () => ({ rules: ruleRef, loading: ref(false), error: ref(null) }),
}))
describe('road plan profile refresh', () => {
  it.each(['manual', 'excluded', 'outside'] as const)(
    'can apply a new profile confirmation with %s outputs without replacing manual choices',
    async (kind) => {
      ruleRef.value = structuredClone(PROTOTYPE_RULES)
      const base = importSchemeJson(fixture).scheme
      base.source = { kind: 'created-in-editor' }
      base.placements = []
      base.nextPlacementId = 1
      delete base.roadObjectExclusions
      base.roadLayout = {
        nextNodeId: 2,
        links: [],
        nodes: [
          {
            id: 1,
            kind: 'junction',
            origin: 'manual',
            position: { approach: 'right', from: 'E', metres: kind === 'outside' ? 301 : 120 },
            side: 'down',
            roadKind: 'road',
            name: 'Учебная ветвь',
            sheetOffsetXSvg: null,
            sideWarningRequested: true,
          },
        ],
      }
      let scheme = applyRoadAutomation(base, prepareRoadAutomation(base))
      if (kind === 'excluded') {
        for (const link of scheme.roadLayout.links)
          if (link.calculation) scheme = removePlacement(scheme, link.placementId)
      } else {
        for (const link of scheme.roadLayout.links)
          if (link.calculation) link.calculation.state = 'modified'
      }
      const onApply = vi.fn(),
        view = renderComponent(RoadAutomation, { scheme, locked: false, onApply })
      const button = (label: string) =>
        nodes(view.root, (n) => n.tag === 'button' && content(n).trim() === label)[0]!
      try {
        await dispatch(button('Подготовить полный план'), 'onClick')
        await nextTick()
        expect(button('Применить полный план').props.disabled).toBeTruthy()
        const confirmed = structuredClone(PROTOTYPE_RULES)
        confirmed.parameterBasis['project-road-profile']!.confirmed = true
        ruleRef.value = confirmed
        await nextTick()
        await dispatch(button('Подготовить полный план'), 'onClick')
        await nextTick()
        expect(button('Применить полный план').props.disabled).toBeFalsy()
        await dispatch(button('Применить полный план'), 'onClick')
        await nextTick()
        const applied = onApply.mock.calls[0]![0]
        expect(
          applied.roadLayout.automation.profile.find(
            (p: { id: string }) => p.id === 'project-road-profile',
          ).confirmed,
        ).toBe(true)
        expect(applied.placements).toEqual(scheme.placements)
        expect(applied.roadLayout.links).toEqual(scheme.roadLayout.links)
      } finally {
        view.unmount()
      }
    },
  )
})
