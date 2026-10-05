import { describe, expect, it } from 'vitest'
import { importSchemeJson, exportSchemeJson } from '../import'
import { schemeSchema, parseStoredScheme } from '../model'
import { parameterDefinitions, rulesFrom, type ParameterState } from '../normative-parameters'
import {
  decisionEvidenceState,
  recordSpeedDecision,
  recordRegulationDecision,
  decisionFindings,
} from '../decision-evidence'
import { createSchemeDetailsDraft, applySchemeDetails } from '../edit-details'
import { recoveryWriteSchema } from '../recovery'
import { markState, setMark } from '../review-marks'
import { reviewScheme } from '../review-scheme'
import { v8Snapshot, v9Snapshot } from '../../../tests/fixtures/old-version'
import fixture from '../../../tests/fixtures/legacy-b34-manual.json?raw'

const now = '2030-05-01T00:00:00.000Z'
function states(): ParameterState[] {
  return parameterDefinitions
    .filter((d) => d.source.kind !== 'decision')
    .map((definition, index) => {
      const source = definition.source
      if (source.kind === 'decision' || definition.fallback === null)
        throw new Error('Expected normative source and value')
      const label = `${source.documentCode}-2030`
      const document = { id: index + 1, label, sha256: 'a'.repeat(64), effectiveFrom: '2030-01-01' }
      return {
        id: definition.id,
        status: { kind: 'confirmed' },
        document,
        confirmationDocument: document,
        amendmentDocuments: [],
        quote: null,
        suggestion: null,
        amendments: [],
        confirmation: {
          id: index + 1,
          parameterId: definition.id,
          documentId: document.id,
          documentLabel: label,
          clause: source.kind === 'table' ? source.clause : `п. ${source.clause}`,
          page: 1,
          quote: 'Вымышленная секретная цитата',
          fragment: 'Вымышленный секретный фрагмент',
          value: definition.fallback,
          confirmedBy: 'Учебный составитель',
          confirmedAt: now,
          note: '',
        },
      }
    })
}
function scheme() {
  const scheme = importSchemeJson(fixture).scheme
  scheme.parameters.location = 'out'
  scheme.parameters.speedConditions = { road: 'ordinary', vehicle: 'heavy' }
  scheme.parameters.regulation = {
    ...scheme.parameters.regulation,
    mode: 'two',
    hourly: '600',
    vis: false,
    straight: true,
  }
  scheme.parameters.workConditions = {
    kind: 'short',
    durationHours: 4,
    daylight: 'day',
    regulatorsPresent: true,
    sectionMetres: 40,
  }
  return scheme
}

describe('historical decision evidence in format v9', () => {
  it('records explicit conditions, actual speed, reference, regulatory input, values and document dates, without PDF text', () => {
    const rules = rulesFrom(states())
    const original = scheme()
    let recorded = recordSpeedDecision(original, rules, 'Учебная сверка потока и знаков', now)
    recorded = recordRegulationDecision(recorded, rules, 'Учебный выбор двух регулировщиков', now)
    expect(recorded.parameters).toEqual(original.parameters)
    expect(recorded.placements).toEqual(original.placements)
    expect(recorded.decisionEvidence.speed).toMatchObject({
      conditions: { road: 'ordinary', vehicle: 'heavy' },
      referenceSpeedKmh: 70,
      approachSpeedKmh: original.parameters.approachSpeedKmh,
    })
    expect(recorded.decisionEvidence.regulation).toMatchObject({
      mode: 'two',
      recommendation: 'two',
      input: { hourly: '600', sectionMetres: 40, workConditions: { durationHours: 4 } },
    })
    const parameter = recorded.decisionEvidence.regulation!.parameters.find(
      (p) => p.id === 'odm-signs-hourly',
    )!
    expect(parameter).toMatchObject({
      value: 250,
      confirmed: true,
      document: { sha256: 'a'.repeat(64), effectiveFrom: '2030-01-01' },
      confirmation: { confirmedAt: now },
    })
    expect(exportSchemeJson(recorded)).not.toContain('секретн')
    expect(importSchemeJson(exportSchemeJson(recorded)).scheme).toEqual(recorded)
    expect(decisionEvidenceState(recorded, 'speed', rules).status).toBe('current')
    expect(decisionEvidenceState(recorded, 'regulation', rules).status).toBe('current')
    original.parameters.speedConditions.vehicle = 'light'
    expect(recorded.decisionEvidence.speed!.conditions.vehicle).toBe('heavy')
  })
  it('upgrades v8 without inventing conditions or evidence, preserving identities, marks, graphics and raw source', () => {
    const original = scheme()
    const previous = v8Snapshot(original)
    const migrated = importSchemeJson(JSON.stringify(previous))
    expect(migrated.format).toBe('scheme-v8')
    expect(migrated.scheme.schemaVersion).toBe(10)
    expect(migrated.scheme.parameters.speedConditions).toEqual({ road: '', vehicle: '' })
    expect(migrated.scheme.decisionEvidence).toEqual({ speed: null, regulation: null })
    // Стойки получили расстояние из прежней подписи; в записи прежнего формата они те же.
    expect(v9Snapshot(migrated.scheme).placements).toEqual(previous.placements)
    expect(migrated.scheme.source).toEqual(previous.source)
    expect(migrated.scheme.reviewMarks).toEqual(previous.reviewMarks)
    expect(migrated.scheme.id).toBe(previous.id)
    expect(parseStoredScheme(previous)).toEqual(migrated.scheme)
  })
  it.each(['speed', 'regulation'] as const)(
    'retains the historical %s snapshot when sources change, and blocks its old mark until an explicit new record',
    (kind) => {
      const sourceStates = states()
      const rules = rulesFrom(sourceStates)
      const record = kind === 'speed' ? recordSpeedDecision : recordRegulationDecision
      let saved = record(scheme(), rules, 'Учебная предметная сверка', now)
      const finding = decisionFindings(saved, rules).find((f) => f.id === `decision-${kind}`)!
      saved = setMark(saved, [finding], finding.id, true, now)
      const snapshot = JSON.stringify(saved.decisionEvidence[kind])
      const relevant = sourceStates.find(
        (s) => s.id === (kind === 'speed' ? 'pdd-speed-outside' : 'odm-signs-hourly'),
      )!
      relevant.document = {
        ...relevant.document!,
        sha256: 'b'.repeat(64),
        effectiveFrom: '2030-02-01',
      }
      const changed = rulesFrom(sourceStates)
      expect(decisionEvidenceState(saved, kind, changed).status).toBe('stale')
      const stale = decisionFindings(saved, changed).find((f) => f.id === finding.id)!
      expect(markState(saved, stale).status).toBe('blocked')
      expect(() => setMark(saved, [stale], stale.id, true, now)).toThrow('устарели')
      expect(JSON.stringify(saved.decisionEvidence[kind])).toBe(snapshot)
      const renewed = record(
        saved,
        changed,
        'Повторная учебная предметная сверка',
        '2030-05-02T00:00:00.000Z',
      )
      expect(decisionEvidenceState(renewed, kind, changed).status).toBe('current')
      expect(
        markState(
          renewed,
          decisionFindings(renewed, changed).find((f) => f.id === finding.id)!,
        ).status,
      ).toBe('stale')
      expect(reviewScheme(renewed, changed).some((f) => f.id === finding.id)).toBe(true)
    },
  )
  it('invalidates speed evidence on selection or sign changes while an unrelated title remains harmless', () => {
    const rules = rulesFrom(states())
    const saved = recordSpeedDecision(scheme(), rules, 'Учебный состав потока', now)
    saved.titleBlock.work.description = 'Другое описание'
    expect(decisionEvidenceState(saved, 'speed', rules).status).toBe('current')
    saved.parameters.speedConditions.vehicle = 'light'
    expect(decisionEvidenceState(saved, 'speed', rules).status).toBe('stale')
    const renewed = recordSpeedDecision(saved, rules, 'Другой учебный состав потока', now)
    const post = renewed.placements.find((p) => p.kind === 'sign-post')!
    if (post.kind !== 'sign-post') throw new Error('Expected sign post')
    post.signIds = ['3.25']
    expect(decisionEvidenceState(renewed, 'speed', rules).status).toBe('stale')
  })
  it.each(['mode', 'duration', 'buffer', 'visibility'] as const)(
    'invalidates regulatory evidence after changing %s',
    (field) => {
      const rules = rulesFrom(states())
      const saved = recordRegulationDecision(scheme(), rules, 'Учебные условия работ', now)
      if (field === 'mode') saved.parameters.regulation.mode = 'one'
      if (field === 'duration') saved.parameters.workConditions.durationHours = 5
      if (field === 'buffer') saved.parameters.workZones.b34!.bufferMetres = 15
      if (field === 'visibility') saved.parameters.regulation.vis = true
      expect(decisionEvidenceState(saved, 'regulation', rules).status).toBe('stale')
    },
  )
  it('keeps explicitly manual speed conditions unknown and preserves preliminary status', () => {
    const original = scheme()
    original.parameters.speedConditions = { road: '', vehicle: '' }
    const rules = rulesFrom()
    const saved = recordSpeedDecision(
      original,
      rules,
      'Скорость задана вручную; фактические ограничения требуют сверки',
      now,
    )
    expect(saved.decisionEvidence.speed?.referenceSpeedKmh).toBeNull()
    expect(saved.decisionEvidence.speed?.parameters.every((p) => !p.confirmed)).toBe(true)
    expect(() =>
      recordRegulationDecision(
        {
          ...original,
          parameters: {
            ...original.parameters,
            regulation: { ...original.parameters.regulation, mode: 'auto' },
          },
        },
        rules,
        'Учебное решение',
        now,
      ),
    ).toThrow('явный режим')
    expect(() => recordSpeedDecision(original, rules, ' ', now)).toThrow('обоснование')
    expect(
      schemeSchema.safeParse({
        ...original,
        parameters: {
          ...original.parameters,
          speedConditions: { road: 'motorway', vehicle: 'light' },
        },
      }).success,
    ).toBe(false)
  })
  it('preserves applied and pending evidence in the recovery draft, and applying unrelated fields does not refresh stale evidence', () => {
    const rules = rulesFrom(states())
    const saved = recordSpeedDecision(scheme(), rules, 'Учебные ограничения', now)
    const draft = createSchemeDetailsDraft(saved)
    draft.parameters.speedConditions = { road: 'ordinary', vehicle: 'light' }
    const pending = applySchemeDetails(saved, draft, rules)
    expect(decisionEvidenceState(pending, 'speed', rules).status).toBe('stale')
    const request = recoveryWriteSchema.parse({
      sessionId: saved.id,
      scheme: saved,
      baseRevision: 1,
      detailsDraft: draft,
      placementDraft: null,
      fileName: 'test.json',
      expectedVersion: 0,
    })
    expect(request.detailsDraft?.parameters.speedConditions).toEqual(
      draft.parameters.speedConditions,
    )
    expect(request.detailsDraft?.decisionEvidence).toEqual(saved.decisionEvidence)
  })
  it('records amendments and detects altered snapshot values, even if the stored digest was left unchanged', () => {
    const sourceStates = states()
    const pdd = sourceStates.find((s) => s.id === 'pdd-speed-outside')!
    pdd.amendmentDocuments = [
      {
        id: 100,
        label: 'Учебное постановление-2030',
        sha256: 'c'.repeat(64),
        effectiveFrom: '2030-04-01',
      },
    ]
    const rules = rulesFrom(sourceStates)
    const saved = recordSpeedDecision(scheme(), rules, 'Учебные ограничения', now)
    const basis = saved.decisionEvidence.speed!.parameters.find((p) => p.id === pdd.id)!
    expect(basis.amendments).toEqual(pdd.amendmentDocuments)
    basis.value = 88
    expect(decisionEvidenceState(saved, 'speed', rules).status).toBe('stale')
  })
  it('keeps the applied document of a previous confirmation separate from the current edition', () => {
    const sourceStates = states()
    const state = sourceStates.find((item) => item.id === 'pdd-speed-outside')!
    const previous = { ...state.document! }
    state.status = { kind: 'changed', previous: 'Учебная прежняя редакция' }
    state.confirmationDocument = previous
    state.document = {
      ...previous,
      id: previous.id + 1000,
      label: 'ПДД-2031',
      sha256: 'b'.repeat(64),
    }
    const rules = rulesFrom(sourceStates)
    const saved = recordSpeedDecision(
      scheme(),
      rules,
      'Учебная ручная сверка прежнего значения',
      now,
    )
    const basis = saved.decisionEvidence.speed!.parameters.find((item) => item.id === state.id)!
    expect(basis.confirmed).toBe(false)
    expect(basis.document).toEqual(previous)
    expect(basis.currentDocument).toEqual(state.document)
    expect(basis.confirmation!.documentLabel).toBe(previous.label)
    expect(basis.value).toBe(state.confirmation!.value)
    expect(decisionEvidenceState(saved, 'speed', rules).status).toBe('current')
  })
})
