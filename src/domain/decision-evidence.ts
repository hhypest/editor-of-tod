import { type DecisionEvidence, type ParameterBasis } from './decision-evidence-schema'
import { evidenceFingerprint } from './evidence-fingerprint'
import { schemeSchema, type Scheme } from './model'
import {
  parameterBasisFingerprint,
  REGULATION_PARAMETERS,
  type NormativeRules,
} from './normative-parameters'
import { postMetres } from './post-distance'
import { pddSpeedReference } from './pdd-speed'
import { adviseRegulation, type RegulationInput } from './regulation-advice'
import { effectiveWorkSection } from './work-traffic'

const speedParameterIds = (rules: NormativeRules) =>
  Object.keys(rules.parameterBasis)
    .filter((id) => id.startsWith('pdd-'))
    .sort()
function bases(ids: readonly string[], rules: NormativeRules): ParameterBasis[] {
  return ids.map((id) => ({ ...rules.parameterBasis[id]! }))
}
/** Знаки, от которых зависит решение о скорости: ограничение и его отмена. */
const SPEED_DECISION_SIGN = /^3\.(?:24|25|31)(?:_|$)/

/**
 * Знаки скорости на листе для отпечатка решения: подход, расстояние в метрах и коды знаков 3.24,
 * 3.25 и 3.31. Координаты на листе, номера стоек и прочие знаки в отпечаток не входят: их
 * изменение не меняет решения о скорости (issue #99). Стойка без расстояния учитывается по
 * составу знаков — её места на местности программа не знает (ADR-0008).
 */
function speedSigns(scheme: Scheme) {
  return scheme.placements
    .flatMap((item) => {
      if (item.kind !== 'sign-post') return []
      const codes = item.signIds.filter((code) => SPEED_DECISION_SIGN.test(code)).sort()
      if (!codes.length) return []
      return [
        {
          approach: item.distance?.approach ?? null,
          metres: item.distance
            ? postMetres(item.distance, scheme.parameters.signDistancesMetres)
            : null,
          codes,
        },
      ]
    })
    .map((item) => JSON.stringify(item))
    .sort()
}
function speedInput(scheme: Scheme) {
  const p = scheme.parameters
  return [p.location, p.speedConditions, p.approachSpeedKmh, p.speedStagesKmh, speedSigns(scheme)]
}
/**
 * Отпечаток записей, сделанных до issue #99: включал стойки целиком. Совпадение с ним тоже
 * означает, что исходные данные не менялись, — иначе обновление программы сделало бы все
 * прежние записи устаревшими.
 */
function legacySpeedInput(scheme: Scheme) {
  const p = scheme.parameters
  return [
    p.location,
    p.speedConditions,
    p.approachSpeedKmh,
    p.speedStagesKmh,
    scheme.placements.filter((item) => item.kind === 'sign-post'),
  ]
}
/**
 * Основание параметра не изменилось. Название параметра и подпись источника — тексты программы,
 * а не основание: их правка в новой версии запись не снимает (issue #99).
 */
function sameParameterBasis(saved: ParameterBasis, rules: NormativeRules): boolean {
  const current = rules.parameterBasis[saved.id]
  if (!current) return false
  const essential = ({
    title: _title,
    source: _source,
    fingerprint: _print,
    ...rest
  }: ParameterBasis) => rest
  if (evidenceFingerprint(essential(saved)) !== evidenceFingerprint(essential(current)))
    return false
  // Отпечаток включает подпись источника: текущий пересчитывается с подписью из записи.
  return (
    saved.fingerprint ===
    parameterBasisFingerprint(
      rules.evidence[saved.id] ?? '',
      current.amendments,
      current.value,
      saved.source,
      current.confirmed,
    )
  )
}
export function regulationInput(scheme: Scheme): RegulationInput {
  const p = scheme.parameters
  const zone = p.workZones[scheme.template.code]
  return {
    hourly: p.regulation.hourly,
    limitedVisibility: p.regulation.vis,
    straight: p.regulation.straight,
    zoneSpeedKmh: p.speedStagesKmh[2],
    taperMetres: zone?.taperMetres ?? null,
    frontMetres: zone?.workMetres ?? null,
    sectionMetres: effectiveWorkSection(zone, p.workConditions, scheme.template.code),
    workConditions: p.workConditions,
  }
}
function savedRegulationInput(
  scheme: Scheme,
): NonNullable<DecisionEvidence['regulation']>['input'] {
  const zone = scheme.parameters.workZones[scheme.template.code]
  return {
    ...regulationInput(scheme),
    variant: scheme.template.code,
    crossingReferenceId: scheme.crossing.referenceId,
    crossingRevision: scheme.crossing.snapshot?.revision ?? null,
    zoneSpeedKmh: scheme.parameters.speedStagesKmh[2],
    bufferMetres: zone?.bufferMetres ?? null,
    workConditions: scheme.parameters.workConditions,
  }
}
function regulationBasis(scheme: Scheme) {
  return [scheme.parameters.regulation.mode, savedRegulationInput(scheme)]
}
function noteText(note: string): string {
  const text = note.trim()
  if (text.length < 2 || text.length > 5_000)
    throw new Error('Укажите обоснование решения (от 2 до 5000 символов).')
  return text
}
/** Явная запись истории, без изменения скорости, режима или геометрии. */
export function recordSpeedDecision(
  scheme: Scheme,
  rules: NormativeRules,
  note: string,
  now = new Date().toISOString(),
): Scheme {
  const p = scheme.parameters
  const reference = pddSpeedReference(
    p.location,
    p.speedConditions.road,
    p.speedConditions.vehicle,
    rules,
  )
  if (p.speedConditions.road === 'motorway')
    throw new Error(
      'Для схемы переезда автомагистраль доступна только для справки; сохранить её как условие решения нельзя.',
    )
  const speed: NonNullable<DecisionEvidence['speed']> = {
    recordedAt: now,
    note: noteText(note),
    inputFingerprint: evidenceFingerprint(speedInput(scheme)),
    parameters: bases(speedParameterIds(rules), rules),
    conditions: p.speedConditions,
    location: p.location,
    approachSpeedKmh: p.approachSpeedKmh,
    speedStagesKmh: p.speedStagesKmh,
    referenceSpeedKmh: reference?.speed ?? null,
  }
  return schemeSchema.parse({ ...scheme, decisionEvidence: { ...scheme.decisionEvidence, speed } })
}
export function recordRegulationDecision(
  scheme: Scheme,
  rules: NormativeRules,
  note: string,
  now = new Date().toISOString(),
): Scheme {
  const mode = scheme.parameters.regulation.mode
  if (mode === 'auto')
    throw new Error('Выберите явный режим пропуска транспорта перед записью обоснования.')
  const advice = adviseRegulation(regulationInput(scheme), rules)
  const regulation: NonNullable<DecisionEvidence['regulation']> = {
    recordedAt: now,
    note: noteText(note),
    inputFingerprint: evidenceFingerprint(regulationBasis(scheme)),
    parameters: bases(REGULATION_PARAMETERS, rules),
    input: savedRegulationInput(scheme),
    mode,
    recommendation: advice.mode,
    reasons: advice.reasons,
    warnings: advice.warnings,
  }
  return schemeSchema.parse({
    ...scheme,
    decisionEvidence: { ...scheme.decisionEvidence, regulation },
  })
}

export function decisionEvidenceState(
  scheme: Scheme,
  kind: keyof DecisionEvidence,
  rules: NormativeRules,
): { status: 'missing' | 'current' | 'stale'; reasons: string[] } {
  const snapshot = scheme.decisionEvidence[kind]
  if (!snapshot) return { status: 'missing', reasons: ['Снимок оснований ещё не записан.'] }
  const reasons: string[] = []
  const inputs =
    kind === 'speed' ? [speedInput(scheme), legacySpeedInput(scheme)] : [regulationBasis(scheme)]
  if (!inputs.some((input) => snapshot.inputFingerprint === evidenceFingerprint(input)))
    reasons.push('Изменены исходные условия, выбранное решение или знаки.')
  const ids = kind === 'speed' ? speedParameterIds(rules) : [...REGULATION_PARAMETERS]
  if (
    snapshot.parameters.length !== ids.length ||
    ids.some((id) => {
      const saved = snapshot.parameters.find((item) => item.id === id)
      return !saved || !sameParameterBasis(saved, rules)
    })
  )
    reasons.push(
      'Изменены нормативные параметры, редакции документов, действующие изменения или записи подтверждения.',
    )
  return { status: reasons.length ? 'stale' : 'current', reasons }
}

export function decisionFindings(scheme: Scheme, rules: NormativeRules) {
  return (['speed', 'regulation'] as const).flatMap((kind) => {
    const saved = scheme.decisionEvidence[kind]
    if (!saved) return []
    const state = decisionEvidenceState(scheme, kind, rules)
    return [
      {
        id: `decision-${kind}`,
        kind: 'verify' as const,
        title:
          kind === 'speed'
            ? 'Сохранённое обоснование скорости'
            : 'Сохранённое обоснование регулирования',
        detail: `Снимок записан ${saved.recordedAt}. ${saved.note} ${state.reasons.join(' ')} Сверьте применимость выбранного решения; запись основания не заменяет предметную проверку.`,
        path: `decisionEvidence.${kind}`,
        basis: JSON.stringify([saved, state]),
        ...(state.status === 'stale'
          ? {
              markBlocked:
                'Сохранённые основания устарели. На этапе 2 сверяйте решение и заново запишите обоснование.',
            }
          : {}),
      },
    ]
  })
}
