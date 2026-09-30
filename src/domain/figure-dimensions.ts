import type { Scheme } from './model'
import { PROTOTYPE_RULES, type NormativeRules } from './normative-parameters'
import { anchorCoordinates } from './placement-workspace'

export type FigureDimension = {
  part: 'entry' | 'buffer' | 'front' | 'exit'
  title: string
  enteredMetres: number
  figureLabel: string
  /** Откуда взято ожидаемое значение, если это не размер на рисунке. */
  basis?: string
  agreesWithFigure: boolean
  startX: number
  endX: number
}

/**
 * Dimension chains on figures B.33 (printed p. 100) and B.34 (p. 101) of
 * ODM 218.6.019-2016. The drawing units are only a schematic projection;
 * they must not be used to infer physical sign positions or distances.
 *
 * Б.34 со знаками приоритета 2.6/2.7: отгон задан п. 4.1.8.3 ОДМ (нормативный параметр
 * `odm-signs-taper`), а не размером на рисунке, поэтому сравнивается с ним.
 */
export function figureDimensions(
  scheme: Scheme,
  rules: NormativeRules = PROTOTYPE_RULES,
): FigureDimension[] {
  const code = scheme.template.code
  const zone = scheme.parameters.workZones[code]
  if (!zone) throw new Error('Параметры выбранного варианта схемы не заполнены.')
  const { L0, L1, Z0, Z1, E } = anchorCoordinates(scheme)
  const longFront = code === 'b33'
  const prioritySigns = !longFront && scheme.parameters.regulation.mode === 'signs'
  const entryMatches = longFront
    ? zone.taperMetres >= 5 && zone.taperMetres <= 10
    : zone.taperMetres === (prioritySigns ? rules.signsTaperMetres : 10)

  const dimensions: FigureDimension[] = [
    {
      part: 'entry',
      title: 'Отвод перед работами',
      enteredMetres: zone.taperMetres,
      figureLabel: longFront ? '5–10 м' : prioritySigns ? `${rules.signsTaperMetres} м` : '10 м',
      ...(prioritySigns
        ? {
            basis: `для знаков 2.6/2.7 — ${rules.signsTaperMetres} м, ${rules.sources['odm-signs-taper']}`,
          }
        : {}),
      agreesWithFigure: entryMatches,
      startX: L0,
      endX: L1,
    },
    {
      part: 'buffer',
      title: 'Участок перед фронтом',
      enteredMetres: zone.bufferMetres,
      figureLabel: longFront ? '15 м' : '10 м',
      agreesWithFigure: zone.bufferMetres === (longFront ? 15 : 10),
      startX: L1,
      endX: Z0,
    },
    {
      part: 'front',
      title: 'Фронт работ',
      enteredMetres: zone.workMetres,
      figureLabel: longFront ? 'min 30 м' : 'max 30 м*',
      // B.34's "max 30" includes the boundary. The project-specific choice
      // of B.33 at exactly 30 m is checked separately in review-scheme.ts.
      agreesWithFigure: longFront ? zone.workMetres >= 30 : zone.workMetres <= 30,
      startX: Z0,
      endX: Z1,
    },
  ]
  if (longFront) {
    dimensions.push({
      part: 'exit',
      title: 'Отвод после работ',
      enteredMetres: zone.taperMetres,
      figureLabel: '5–10 м',
      agreesWithFigure: entryMatches,
      startX: Z1,
      endX: E,
    })
  }
  return dimensions
}
